import { describe, expect, it } from 'vitest'
import { buildRequest, createStreamCollector, isApiKeyOptional, readSSE } from '../src/main/llm'
import { parseSummaryResponse } from '../src/main/compact'
import { chatEndpointForProfile, selectContextExchange } from '../src/shared/contextUsage'
import { globToRegExp } from '../src/main/tools/search'
import type { ChatEvent, DebugListItem, LLMConfig, LLMProfileView } from '../src/shared/types'
import type { ToolDefinition } from '../src/main/tools'

function makeProfile(overrides: Partial<LLMConfig> & { provider: LLMConfig['provider'] }): LLMConfig {
  return {
    name: 'Test',
    baseURL: '',
    model: 'test-model',
    proxyURL: '',
    ...overrides,
  }
}

const sampleTurns: Parameters<typeof buildRequest>[2] = [
  { kind: 'user', text: 'Read package.json' },
  {
    kind: 'assistant',
    reasoning: [{ text: 'I should call read_file' }],
    text: '',
    toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{"path":"package.json"}' }],
  },
  {
    kind: 'tool_results',
    results: [{ toolUseId: 'call_1', content: '{"name":"demo"}', isError: false }],
  },
]

const sampleTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    kind: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to file', additionalProperties: false } },
      required: ['path'],
    },
    async execute() {
      return { content: '' }
    },
  },
]

describe('Multi-protocol LLM request building & streaming', () => {
  it('builds Google Gemini generateContent request and sanitizes tool schemas', () => {
    const llm = makeProfile({
      provider: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-pro',
      thinkingEffort: 'medium',
    })
    const req = buildRequest(llm, 'sk-test-123', sampleTurns, sampleTools, true, 'You are helpful')
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(req.headers['x-goog-api-key']).toBe('sk-test-123')
    const body = JSON.parse(req.body)
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] })
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
    expect(body.tools[0].functionDeclarations[0].name).toBe('read_file')
    expect(body.tools[0].functionDeclarations[0].parameters.properties.path.additionalProperties).toBeUndefined()
    // user message + assistant functionCall + user functionResponse
    expect(body.contents).toHaveLength(3)
    expect(body.contents[1].role).toBe('model')
    expect(body.contents[2].role).toBe('user')
    expect(body.contents[2].parts[0].functionResponse.name).toBe('read_file')
  })

  it('collects Gemini SSE chunks (thoughts, text, and functionCall)', () => {
    const events: ChatEvent[] = []
    const collector = createStreamCollector('gemini', 's1', (e) => events.push(e))
    collector.onEvent({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'Thinking step...', thought: true },
            { text: 'Hello world' },
            { functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'README.md' } } },
          ],
        },
      }],
    })
    const res = collector.finish()
    expect(res.reasoning).toBe('Thinking step...')
    expect(res.blocks).toEqual([
      { type: 'reasoning', text: 'Thinking step...' },
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'fc_1', name: 'read_file', input: { path: 'README.md' }, status: 'running' },
    ])
  })

  it('builds OpenAI Responses API (/v1/responses) request and collects stream events', () => {
    const llm = makeProfile({
      provider: 'openai-responses',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5',
      thinkingEffort: 'high',
    })
    const req = buildRequest(llm, 'sk-test-123', sampleTurns, sampleTools, true, 'Sys prompt')
    expect(req.url).toBe('https://api.openai.com/v1/responses')
    expect(req.headers.authorization).toBe('Bearer sk-test-123')
    const body = JSON.parse(req.body)
    expect(body.instructions).toBe('Sys prompt')
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'read_file' })
    expect(body.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"package.json"}' })
    expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"name":"demo"}' })

    const collector = createStreamCollector('openai-responses', 's1', () => {})
    collector.onEvent({ type: 'response.reasoning_summary_text.delta', delta: 'Plan...' })
    collector.onEvent({ type: 'response.output_text.delta', delta: 'Done!' })
    collector.onEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_99', name: 'read_file', arguments: '' },
    })
    collector.onEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"path":"src/index.ts"}',
    })
    collector.onEvent({ type: 'response.completed', response: { status: 'completed' } })
    const finished = collector.finish()
    expect(finished.reasoning).toBe('Plan...')
    expect(finished.blocks).toEqual([
      { type: 'reasoning', text: 'Plan...' },
      { type: 'text', text: 'Done!' },
      { type: 'tool_use', id: 'call_99', name: 'read_file', input: { path: 'src/index.ts' }, status: 'running' },
    ])
  })

  it('builds Azure OpenAI request with api-key header and deployment URL', () => {
    const llm = makeProfile({
      provider: 'azure-openai',
      baseURL: 'https://my-resource.openai.azure.com',
      model: 'gpt-4.1',
    })
    const req = buildRequest(llm, 'sk-test-123', sampleTurns, sampleTools, true, 'Sys')
    expect(req.url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview')
    expect(req.headers['api-key']).toBe('sk-test-123')
    expect(req.headers.Authorization).toBeUndefined()
  })

  it('builds Ollama native /api/chat request without requiring API key and parses NDJSON stream', async () => {
    const llm = makeProfile({
      provider: 'ollama',
      baseURL: 'http://localhost:11434',
      model: 'qwen3:32b',
    })
    expect(isApiKeyOptional(llm)).toBe(true)
    const req = buildRequest(llm, '', sampleTurns, sampleTools, true, 'Sys')
    expect(req.url).toBe('http://localhost:11434/api/chat')
    expect(req.headers.Authorization).toBeUndefined()

    const collector = createStreamCollector('ollama', 's1', () => {})
    const ndjson = [
      JSON.stringify({ message: { role: 'assistant', thinking: 'Let me think', content: '' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: 'Result text', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] }, done: true }),
    ].join('\n') + '\n'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson))
        controller.close()
      },
    })
    await readSSE(stream, (json) => { if (json) collector.onEvent(json) }, 'ollama')
    const finished = collector.finish()
    expect(finished.reasoning).toBe('Let me think')
    expect(finished.blocks).toEqual([
      { type: 'reasoning', text: 'Let me think' },
      { type: 'text', text: 'Result text' },
      expect.objectContaining({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } }),
    ])
  })

  it('builds Cohere v2 chat request and collects Cohere v2 stream events', () => {
    const llm = makeProfile({
      provider: 'cohere',
      baseURL: 'https://api.cohere.com/v2',
      model: 'command-a-03-2025',
    })
    const req = buildRequest(llm, 'sk-test-123', sampleTurns, sampleTools, true, 'Sys')
    expect(req.url).toBe('https://api.cohere.com/v2/chat')
    expect(req.headers.authorization).toBe('Bearer sk-test-123')

    const collector = createStreamCollector('cohere', 's1', () => {})
    collector.onEvent({ type: 'content-delta', delta: { message: { content: { text: 'Cohere reply' } } } })
    collector.onEvent({
      type: 'tool-call-start',
      index: 0,
      delta: { message: { tool_calls: { id: 'tc_cohere', function: { name: 'read_file', arguments: '' } } } },
    })
    collector.onEvent({
      type: 'tool-call-delta',
      index: 0,
      delta: { message: { tool_calls: { function: { arguments: '{"path":"index.ts"}' } } } },
    })
    collector.onEvent({ type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } })
    const finished = collector.finish()
    expect(finished.blocks).toEqual([
      { type: 'text', text: 'Cohere reply' },
      { type: 'tool_use', id: 'tc_cohere', name: 'read_file', input: { path: 'index.ts' }, status: 'running' },
    ])
  })

  it('extracts non-streaming summary across all 7 protocols and matches context exchanges', () => {
    expect(parseSummaryResponse('gemini', {
      candidates: [{ content: { parts: [{ text: 'thought', thought: true }, { text: 'Gemini summary' }] } }],
    })).toBe('Gemini summary')
    expect(parseSummaryResponse('openai-responses', {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Responses summary' }] }],
    })).toBe('Responses summary')
    expect(parseSummaryResponse('ollama', {
      message: { content: 'Ollama summary' },
    })).toBe('Ollama summary')
    expect(parseSummaryResponse('cohere', {
      message: { content: [{ type: 'text', text: 'Cohere summary' }] },
    })).toBe('Cohere summary')

    const geminiProfile: LLMProfileView = {
      id: 'p1',
      name: 'Gemini',
      provider: 'gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      proxyURL: '',
      hasApiKey: true,
      apiKeyHint: '••••',
    }
    const endpoint = chatEndpointForProfile(geminiProfile)
    expect(endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    const item: DebugListItem = {
      id: '1',
      kind: 'chat',
      sessionId: 's1',
      profileId: 'p1',
      scope: 'main',
      round: 1,
      startedAt: 100,
      durationMs: 10,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      url: endpoint,
      status: 200,
      error: null,
      eventCount: 2,
      inputTokens: 1200,
      outputTokens: 50,
      contextTokens: 1200,
      breakdown: null,
      cost: null,
    }
    const matched = selectContextExchange([item], 's1', geminiProfile)
    expect(matched?.inputTokens).toBe(1200)
  })

  it('globToRegExp does not allow /**/ to match partial filename prefixes without a slash', () => {
    expect(globToRegExp('a/**/b.ts').test('a/b.ts')).toBe(true)
    expect(globToRegExp('a/**/b.ts').test('a/c/d/b.ts')).toBe(true)
    expect(globToRegExp('a/**/b.ts').test('a/xb.ts')).toBe(false)
  })
})
