import { useState } from 'react'
import { useApp } from '../../store'
import * as actions from '../../actions'
import type { BalanceResult, LLMProfileView, ProviderType } from '../../../../shared/types'
import { Icon } from '../Icon'
import { SettingsNotice, type SettingsNoticeValue } from './SettingsNotice'

/** 预设配置：选一下就填好名称 / 协议 / BaseURL，模型给出常见候选（仍可手输），附官方文档 */
interface ProviderPreset {
  id: string
  group: '国内主流大模型' | '海外主流大模型' | '聚合网关与算力云' | '本地部署与自建网关' | '自定义'
  label: string
  name: string
  provider: ProviderType
  baseURL: string
  models: string[]
  docsURL: string
}

const PRESETS: ProviderPreset[] = [
  // ---------- 国内主流大模型 ----------
  {
    id: 'deepseek',
    group: '国内主流大模型',
    label: 'DeepSeek（官方 OpenAI 兼容）',
    name: 'DeepSeek',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    docsURL: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'deepseek-anthropic',
    group: '国内主流大模型',
    label: 'DeepSeek（Anthropic 兼容端点）',
    name: 'DeepSeek (Anthropic)',
    provider: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    docsURL: 'https://api-docs.deepseek.com/guides/anthropic_api',
  },
  {
    id: 'dashscope',
    group: '国内主流大模型',
    label: '阿里云百炼 / 通义千问（DashScope）',
    name: '通义千问 Qwen',
    provider: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen3-coder-plus', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-plus'],
    docsURL: 'https://help.aliyun.com/zh/model-studio/getting-started/models',
  },
  {
    id: 'zhipu',
    group: '国内主流大模型',
    label: '智谱 GLM（BigModel 官方）',
    name: '智谱 GLM',
    provider: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.7', 'glm-4.6', 'glm-4.5'],
    docsURL: 'https://docs.bigmodel.cn/cn/guide/start/quickstart',
  },
  {
    id: 'zhipu-anthropic',
    group: '国内主流大模型',
    label: '智谱 GLM（Anthropic 兼容端点）',
    name: '智谱 GLM (Anthropic)',
    provider: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    models: ['glm-5.3', 'glm-5.2', 'glm-4.7', 'glm-4.6', 'glm-4.5'],
    docsURL: 'https://docs.bigmodel.cn/cn/guide/start/quickstart',
  },
  {
    id: 'kimi',
    group: '国内主流大模型',
    label: '月之暗面（Moonshot Kimi）',
    name: 'Moonshot Kimi',
    provider: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'kimi-k2-turbo-preview', 'kimi-latest', 'moonshot-v1-128k'],
    docsURL: 'https://platform.moonshot.cn/docs/introduction',
  },
  {
    id: 'volcengine',
    group: '国内主流大模型',
    label: '字节跳动豆包 / 火山方舟（Volcengine Ark）',
    name: '火山方舟豆包',
    provider: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-thinking-250615', 'doubao-1-5-pro-256k-250115', 'deepseek-r1-250528'],
    docsURL: 'https://www.volcengine.com/docs/82379/1099475',
  },
  {
    id: 'hunyuan',
    group: '国内主流大模型',
    label: '腾讯混元（Hunyuan）',
    name: '腾讯混元',
    provider: 'openai-compatible',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-t1-latest', 'hunyuan-turbos-latest', 'hunyuan-pro', 'hunyuan-standard'],
    docsURL: 'https://cloud.tencent.com/document/product/1729/111007',
  },
  {
    id: 'qianfan',
    group: '国内主流大模型',
    label: '百度文心千帆（Qianfan V2）',
    name: '百度千帆',
    provider: 'openai-compatible',
    baseURL: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.5-turbo-128k', 'ernie-x1-turbo-32k', 'deepseek-r1'],
    docsURL: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/s/2m3f0959a',
  },
  {
    id: 'minimax',
    group: '国内主流大模型',
    label: 'MiniMax（海螺 AI）',
    name: 'MiniMax',
    provider: 'openai-compatible',
    baseURL: 'https://api.minimax.chat/v1',
    models: ['MiniMax-M1', 'MiniMax-Text-01', 'abab6.5s-chat'],
    docsURL: 'https://platform.minimaxi.com/document/Introduction',
  },
  {
    id: 'stepfun',
    group: '国内主流大模型',
    label: '阶跃星辰（StepFun）',
    name: '阶跃星辰',
    provider: 'openai-compatible',
    baseURL: 'https://api.stepfun.com/v1',
    models: ['step-3', 'step-r1-v-mini', 'step-2-16k', 'step-1-256k'],
    docsURL: 'https://platform.stepfun.com/docs/overview/concept',
  },
  {
    id: 'yi',
    group: '国内主流大模型',
    label: '零一万物（Yi / Lingyiwanwu）',
    name: '零一万物 Yi',
    provider: 'openai-compatible',
    baseURL: 'https://api.lingyiwanwu.com/v1',
    models: ['yi-lightning', 'yi-large', 'yi-medium'],
    docsURL: 'https://platform.lingyiwanwu.com/docs',
  },
  {
    id: 'baichuan',
    group: '国内主流大模型',
    label: '百川智能（Baichuan）',
    name: '百川智能',
    provider: 'openai-compatible',
    baseURL: 'https://api.baichuan-ai.com/v1',
    models: ['Baichuan4-Turbo', 'Baichuan4-Air', 'Baichuan4'],
    docsURL: 'https://platform.baichuan-ai.com/docs/api',
  },
  {
    id: 'spark',
    group: '国内主流大模型',
    label: '讯飞星火（Spark）',
    name: '讯飞星火',
    provider: 'openai-compatible',
    baseURL: 'https://spark-api-open.xf-yun.com/v1',
    models: ['x1', '4.0Ultra', 'generalv3.5', 'lite'],
    docsURL: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html',
  },
  {
    id: 'sensenova',
    group: '国内主流大模型',
    label: '商汤日日新（SenseNova）',
    name: '商汤日日新',
    provider: 'openai-compatible',
    baseURL: 'https://api.sensenova.cn/compatible-mode/v1',
    models: ['SenseChat-5', 'SenseChat-Turbo'],
    docsURL: 'https://platform.sensenova.cn/',
  },
  {
    id: 'mimo',
    group: '国内主流大模型',
    label: '小米 MiMo',
    name: '小米 MiMo',
    provider: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1',
    models: ['MiMo-7B-RL'],
    docsURL: 'https://platform.xiaomimimo.com/',
  },

  // ---------- 海外主流大模型 ----------
  {
    id: 'openai',
    group: '海外主流大模型',
    label: 'OpenAI 官方（Chat Completions）',
    name: 'OpenAI',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini', 'o3'],
    docsURL: 'https://platform.openai.com/docs/quickstart',
  },
  {
    id: 'openai-responses',
    group: '海外主流大模型',
    label: 'OpenAI 官方（Responses API 原生协议）',
    name: 'OpenAI Responses',
    provider: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'o4-mini', 'o3'],
    docsURL: 'https://platform.openai.com/docs/api-reference/responses',
  },
  {
    id: 'anthropic',
    group: '海外主流大模型',
    label: 'Anthropic（Claude 官方）',
    name: 'Anthropic',
    provider: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
    docsURL: 'https://docs.claude.com/zh-CN/docs/get-started',
  },
  {
    id: 'gemini',
    group: '海外主流大模型',
    label: 'Google Gemini（官方原生协议）',
    name: 'Google Gemini',
    provider: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    docsURL: 'https://ai.google.dev/gemini-api/docs',
  },
  {
    id: 'gemini-openai',
    group: '海外主流大模型',
    label: 'Google Gemini（OpenAI 兼容端点）',
    name: 'Google Gemini (OpenAI)',
    provider: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    docsURL: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'xai',
    group: '海外主流大模型',
    label: 'xAI（Grok 官方）',
    name: 'xAI Grok',
    provider: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    docsURL: 'https://docs.x.ai/',
  },
  {
    id: 'mistral',
    group: '海外主流大模型',
    label: 'Mistral AI（Codestral / Mistral）',
    name: 'Mistral AI',
    provider: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'codestral-latest', 'ministral-8b-latest'],
    docsURL: 'https://docs.mistral.ai/',
  },
  {
    id: 'cohere',
    group: '海外主流大模型',
    label: 'Cohere（V2 原生协议）',
    name: 'Cohere',
    provider: 'cohere',
    baseURL: 'https://api.cohere.com/v2',
    models: ['command-a-03-2025', 'command-r-plus-08-2024', 'command-r-08-2024'],
    docsURL: 'https://docs.cohere.com/reference/chat',
  },
  {
    id: 'azure-openai',
    group: '海外主流大模型',
    label: 'Azure OpenAI Service',
    name: 'Azure OpenAI',
    provider: 'azure-openai',
    baseURL: 'https://YOUR_RESOURCE.openai.azure.com',
    models: ['gpt-5', 'gpt-4.1', 'o4-mini'],
    docsURL: 'https://learn.microsoft.com/azure/ai-services/openai/',
  },
  {
    id: 'bedrock',
    group: '海外主流大模型',
    label: 'Amazon Bedrock（OpenAI 兼容端点）',
    name: 'AWS Bedrock',
    provider: 'openai-compatible',
    baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    models: ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.deepseek.r1-v1:0'],
    docsURL: 'https://docs.aws.amazon.com/bedrock/',
  },
  {
    id: 'perplexity',
    group: '海外主流大模型',
    label: 'Perplexity（Sonar 联网搜索模型）',
    name: 'Perplexity',
    provider: 'openai-compatible',
    baseURL: 'https://api.perplexity.ai',
    models: ['sonar-pro', 'sonar-reasoning-pro', 'sonar'],
    docsURL: 'https://docs.perplexity.ai/',
  },
  {
    id: 'nvidia-nim',
    group: '海外主流大模型',
    label: 'NVIDIA NIM',
    name: 'NVIDIA NIM',
    provider: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    models: ['deepseek-ai/deepseek-r1', 'meta/llama-3.3-70b-instruct', 'qwen/qwen2.5-coder-32b-instruct'],
    docsURL: 'https://build.nvidia.com/',
  },
  {
    id: 'github-models',
    group: '海外主流大模型',
    label: 'GitHub Models',
    name: 'GitHub Models',
    provider: 'openai-compatible',
    baseURL: 'https://models.github.ai/inference',
    models: ['openai/gpt-4.1', 'deepseek/DeepSeek-R1', 'xai/grok-3'],
    docsURL: 'https://docs.github.com/en/github-models',
  },

  // ---------- 聚合网关与算力云 ----------
  {
    id: 'siliconflow',
    group: '聚合网关与算力云',
    label: '硅基流动（SiliconFlow）',
    name: '硅基流动',
    provider: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-4.5'],
    docsURL: 'https://docs.siliconflow.cn/',
  },
  {
    id: 'openrouter',
    group: '聚合网关与算力云',
    label: 'OpenRouter（全球多模型聚合）',
    name: 'OpenRouter',
    provider: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'openai/gpt-5', 'deepseek/deepseek-chat-v3'],
    docsURL: 'https://openrouter.ai/docs/quick-start',
  },
  {
    id: 'groq',
    group: '聚合网关与算力云',
    label: 'Groq（LPU 超高速推理）',
    name: 'Groq',
    provider: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'qwen-qwq-32b'],
    docsURL: 'https://console.groq.com/docs/quickstart',
  },
  {
    id: 'together',
    group: '聚合网关与算力云',
    label: 'Together AI',
    name: 'Together AI',
    provider: 'openai-compatible',
    baseURL: 'https://api.together.xyz/v1',
    models: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
    docsURL: 'https://docs.together.ai/',
  },
  {
    id: 'fireworks',
    group: '聚合网关与算力云',
    label: 'Fireworks AI',
    name: 'Fireworks AI',
    provider: 'openai-compatible',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/deepseek-r1'],
    docsURL: 'https://docs.fireworks.ai/',
  },
  {
    id: 'cerebras',
    group: '聚合网关与算力云',
    label: 'Cerebras Inference',
    name: 'Cerebras',
    provider: 'openai-compatible',
    baseURL: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'qwen-3-32b', 'llama3.1-8b'],
    docsURL: 'https://inference-docs.cerebras.ai/',
  },
  {
    id: 'deepinfra',
    group: '聚合网关与算力云',
    label: 'DeepInfra',
    name: 'DeepInfra',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    models: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
    docsURL: 'https://deepinfra.com/docs',
  },
  {
    id: 'sambanova',
    group: '聚合网关与算力云',
    label: 'SambaNova Cloud',
    name: 'SambaNova',
    provider: 'openai-compatible',
    baseURL: 'https://api.sambanova.ai/v1',
    models: ['DeepSeek-R1', 'DeepSeek-V3-0324', 'Meta-Llama-3.3-70B-Instruct'],
    docsURL: 'https://docs.sambanova.ai/',
  },
  {
    id: 'novita',
    group: '聚合网关与算力云',
    label: 'Novita AI',
    name: 'Novita AI',
    provider: 'openai-compatible',
    baseURL: 'https://api.novita.ai/v3/openai',
    models: ['deepseek/deepseek-r1', 'deepseek/deepseek-v3'],
    docsURL: 'https://novita.ai/docs',
  },
  {
    id: 'modelscope',
    group: '聚合网关与算力云',
    label: '魔搭社区（ModelScope API-Inference）',
    name: '魔搭 ModelScope',
    provider: 'openai-compatible',
    baseURL: 'https://api-inference.modelscope.cn/v1',
    models: ['Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3'],
    docsURL: 'https://modelscope.cn/docs/model-service/API-Inference/intro',
  },
  {
    id: 'ppio',
    group: '聚合网关与算力云',
    label: 'PPIO 派欧算力云',
    name: 'PPIO 派欧云',
    provider: 'openai-compatible',
    baseURL: 'https://api.ppinfra.com/v3/openai',
    models: ['deepseek/deepseek-r1', 'deepseek/deepseek-v3', 'qwen/qwen2.5-coder-32b-instruct'],
    docsURL: 'https://ppinfra.com/docs',
  },
  {
    id: 'gitee-ai',
    group: '聚合网关与算力云',
    label: '模力方舟（Gitee AI）',
    name: '模力方舟 Gitee AI',
    provider: 'openai-compatible',
    baseURL: 'https://ai.gitee.com/v1',
    models: ['DeepSeek-R1', 'DeepSeek-V3', 'Qwen2.5-Coder-32B-Instruct'],
    docsURL: 'https://ai.gitee.com/docs',
  },

  // ---------- 本地部署与自建网关 ----------
  {
    id: 'ollama-native',
    group: '本地部署与自建网关',
    label: 'Ollama（本地原生协议 /api/chat，免密）',
    name: 'Ollama 原生',
    provider: 'ollama',
    baseURL: 'http://localhost:11434',
    models: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.3:latest'],
    docsURL: 'https://docs.ollama.com/',
  },
  {
    id: 'ollama',
    group: '本地部署与自建网关',
    label: 'Ollama（OpenAI 兼容 /v1，免密）',
    name: 'Ollama 本地',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen3:8b', 'deepseek-r1:8b'],
    docsURL: 'https://docs.ollama.com/',
  },
  {
    id: 'lmstudio',
    group: '本地部署与自建网关',
    label: 'LM Studio（本地服务，免密）',
    name: 'LM Studio',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:1234/v1',
    models: [],
    docsURL: 'https://lmstudio.ai/docs',
  },
  {
    id: 'vllm',
    group: '本地部署与自建网关',
    label: 'vLLM（本地/私有化推理服务）',
    name: 'vLLM',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    models: [],
    docsURL: 'https://docs.vllm.ai/',
  },
  {
    id: 'llamacpp',
    group: '本地部署与自建网关',
    label: 'llama.cpp Server（本地服务）',
    name: 'llama.cpp',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:8080/v1',
    models: [],
    docsURL: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    id: 'xinference',
    group: '本地部署与自建网关',
    label: 'Xinference（Xorbits Inference）',
    name: 'Xinference',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:9997/v1',
    models: [],
    docsURL: 'https://inference.readthedocs.io/',
  },
  {
    id: 'oneapi',
    group: '本地部署与自建网关',
    label: 'OneAPI / NewAPI（自建聚合网关）',
    name: 'NewAPI 网关',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:3000/v1',
    models: [],
    docsURL: 'https://github.com/QuantumNous/new-api',
  },
  {
    id: 'custom',
    group: '自定义',
    label: '自定义…',
    name: '',
    provider: 'openai-compatible',
    baseURL: '',
    models: [],
    docsURL: '',
  },
]

const PRESET_GROUPS: ProviderPreset['group'][] = [
  '国内主流大模型',
  '海外主流大模型',
  '聚合网关与算力云',
  '本地部署与自建网关',
  '自定义',
]

const PROVIDER_OPTIONS: {
  value: ProviderType
  label: string
  shortLabel: string
  baseURLPlaceholder: string
  modelPlaceholder: string
}[] = [
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容 Chat Completions（DeepSeek / 千问 / GLM / Kimi / 豆包 / OpenRouter / vLLM…）',
    shortLabel: 'OpenAI 兼容',
    baseURLPlaceholder: 'https://api.deepseek.com/v1',
    modelPlaceholder: 'deepseek-chat',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses API（/v1/responses，GPT-5 / o 系列原生协议）',
    shortLabel: 'OpenAI Responses',
    baseURLPlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'gpt-5',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages API（/v1/messages，Claude 官方及 DeepSeek/GLM 兼容端点）',
    shortLabel: 'Anthropic',
    baseURLPlaceholder: 'https://api.anthropic.com（可留空走默认）',
    modelPlaceholder: 'claude-sonnet-4-5',
  },
  {
    value: 'gemini',
    label: 'Google Gemini 原生协议（/v1beta/models/:generateContent）',
    shortLabel: 'Google Gemini',
    baseURLPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    modelPlaceholder: 'gemini-2.5-pro',
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI Service（/openai/deployments/{model}/chat/completions）',
    shortLabel: 'Azure OpenAI',
    baseURLPlaceholder: 'https://your-resource.openai.azure.com',
    modelPlaceholder: 'gpt-4.1（或部署名）',
  },
  {
    value: 'ollama',
    label: 'Ollama 原生协议（/api/chat，支持本地免密与思考块）',
    shortLabel: 'Ollama 原生',
    baseURLPlaceholder: 'http://localhost:11434',
    modelPlaceholder: 'qwen3:8b',
  },
  {
    value: 'cohere',
    label: 'Cohere V2 Chat API（/v2/chat，Command A / R+ 原生协议）',
    shortLabel: 'Cohere V2',
    baseURLPlaceholder: 'https://api.cohere.com/v2',
    modelPlaceholder: 'command-a-03-2025',
  },
]

function providerShortLabel(provider: ProviderType): string {
  return PROVIDER_OPTIONS.find((o) => o.value === provider)?.shortLabel ?? provider
}

const stripSlash = (s: string): string => s.replace(/\/+$/, '')

/** 按 baseURL + provider 反查预设，匹配不上算自定义 */
function detectPresetId(llm: LLMProfileView | null): string {
  if (!llm) return 'custom'
  const hit = PRESETS.find(
    (p) => p.baseURL && stripSlash(p.baseURL) === stripSlash(llm.baseURL) && p.provider === llm.provider,
  )
  return hit?.id ?? 'custom'
}

interface ProfileDraft {
  id: string | null // null = 新增
  presetId: string
  name: string
  provider: ProviderType
  baseURL: string
  model: string
  proxyURL: string
  apiKey: string
  /** 编辑已有配置档时用于 apiKey 占位提示 */
  hasApiKey: boolean
  apiKeyHint: string
  contextWindowOverride: string
}

function draftFromProfile(p: LLMProfileView): ProfileDraft {
  return {
    id: p.id,
    presetId: detectPresetId(p),
    name: p.name,
    provider: p.provider,
    baseURL: p.baseURL,
    model: p.model,
    proxyURL: p.proxyURL,
    apiKey: '',
    hasApiKey: p.hasApiKey,
    apiKeyHint: p.apiKeyHint,
    contextWindowOverride: p.contextWindowOverride?.toString() ?? '',
  }
}

function blankDraft(): ProfileDraft {
  return {
    id: null,
    presetId: 'custom',
    name: '',
    provider: 'openai-compatible',
    baseURL: '',
    model: '',
    proxyURL: '',
    apiKey: '',
    hasApiKey: false,
    apiKeyHint: '',
    contextWindowOverride: '',
  }
}

/** LLM 配置页：配置档管理器（列表 + 新增/编辑/删除，激活项在输入框下方可随时切换） */
export function LlmConfigPage() {
  const { llmProfiles, activeLlmId } = useApp()
  const [editing, setEditing] = useState<ProfileDraft | null>(null)
  const [fetchedByProfile, setFetchedByProfile] = useState<Record<string, { id: string; name?: string }[]>>({})
  const [draftFetchedModels, setDraftFetchedModels] = useState<{ id: string; name?: string }[]>([])
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [balanceFor, setBalanceFor] = useState<Record<string, BalanceResult>>({})
  const [rowNotice, setRowNotice] = useState<{ profileId: string; tone: 'success' | 'warning'; text: string } | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [refreshingContext, setRefreshingContext] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<SettingsNoticeValue | null>(null)
  const [saved, setSaved] = useState(false)

  const fetchModelsFor = async (p: LLMProfileView): Promise<void> => {
    setFetchingModels(true)
    try {
      const r = await window.api.listModels({ id: p.id, provider: p.provider, name: p.name, baseURL: p.baseURL, proxyURL: p.proxyURL })
      if (!r.ok) {
        setRowNotice({ profileId: p.id, tone: 'warning', text: `获取模型列表失败：${r.error ?? '未知错误'}` })
      } else if (r.fallback) {
        setFetchedByProfile((prev) => ({ ...prev, [p.id]: r.models }))
        setRowNotice({ profileId: p.id, tone: 'warning', text: `该服务商未提供模型列表接口，已显示常用模型（${r.models.length} 个）` })
      } else {
        setFetchedByProfile((prev) => ({ ...prev, [p.id]: r.models }))
        setRowNotice({ profileId: p.id, tone: 'success', text: `已获取 ${r.models.length} 个模型，编辑时输入框可选` })
      }
    } finally {
      setFetchingModels(false)
    }
  }

  const fetchModelsInDraft = async (): Promise<void> => {
    if (!editing) return
    setFetchingModels(true)
    setTestResult(null)
    try {
      const r = await window.api.listModels({
        id: editing.id ?? undefined,
        provider: editing.provider,
        name: editing.name,
        baseURL: editing.baseURL,
        proxyURL: editing.proxyURL,
        apiKey: editing.apiKey.trim() || undefined,
      })
      if (!r.ok) {
        setTestResult({ tone: 'error', text: `获取模型列表失败：${r.error ?? '未知错误'}` })
      } else {
        setDraftFetchedModels(r.models)
        if (editing.id) {
          setFetchedByProfile((prev) => ({ ...prev, [editing.id!]: r.models }))
        }
        if (!editing.model && r.models[0]?.id) {
          setEditing((prev) => (prev ? { ...prev, model: r.models[0].id } : prev))
        }
        setTestResult({
          tone: r.fallback ? 'warning' : 'success',
          text: r.fallback
            ? `该服务商未开放模型列表接口，已填入内置常用模型（${r.models.length} 个）`
            : `已从服务端获取 ${r.models.length} 个可用模型`,
        })
      }
    } finally {
      setFetchingModels(false)
    }
  }

  const [balanceBusy, setBalanceBusy] = useState(false)
  const queryBalanceFor = async (profileId: string): Promise<void> => {
    setBalanceBusy(true)
    try {
      const r = await window.api.queryBalance(profileId)
      setBalanceFor((prev) => ({ ...prev, [profileId]: r }))
    } finally {
      setBalanceBusy(false)
    }
  }

  const startNew = (): void => {
    setTestResult(null)
    setDraftFetchedModels([])
    setEditing(blankDraft())
  }

  const startEdit = (p: LLMProfileView): void => {
    setTestResult(null)
    setDraftFetchedModels(fetchedByProfile[p.id] ?? [])
    setEditing(draftFromProfile(p))
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    const override = editing.contextWindowOverride.trim() ? Number(editing.contextWindowOverride) : 0
    if (!Number.isSafeInteger(override) || override < 0) {
      setTestResult({ tone: 'error', text: '上下文容量必须是非负整数，留空表示自动获取' })
      return
    }
    await actions.saveProfile({
      id: editing.id ?? undefined,
      name: editing.name,
      provider: editing.provider,
      baseURL: editing.baseURL,
      model: editing.model,
      proxyURL: editing.proxyURL,
      apiKey: editing.apiKey.trim() || undefined,
      contextWindowOverride: override,
    })
    setEditing(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const remove = async (p: LLMProfileView): Promise<void> => {
    if (
      !await actions.confirm(
        `删除配置档「${p.name}」？${
          p.id === activeLlmId ? '\n\n这是当前激活的配置档，删除后会自动切换到列表中的第一个。' : ''
        }`,
      )
    ) {
      return
    }
    await actions.deleteProfile(p.id)
  }

  const test = async (): Promise<void> => {
    if (!editing) return
    setTesting(true)
    setTestResult(null)
    const res = await window.api.testLlm({
      id: editing.id ?? undefined,
      name: editing.name,
      provider: editing.provider,
      baseURL: editing.baseURL,
      model: editing.model,
      proxyURL: editing.proxyURL,
      apiKey: editing.apiKey.trim() || undefined,
    })
    setTestResult({ tone: res.ok ? 'success' : 'error', text: res.message })
    setTesting(false)
  }

  // ---------- 编辑器视图 ----------
  if (editing) {
    const preset = PRESETS.find((p) => p.id === editing.presetId) ?? PRESETS[PRESETS.length - 1]
    const providerOption = PROVIDER_OPTIONS.find((o) => o.value === editing.provider) ?? PROVIDER_OPTIONS[0]

    const applyPreset = (presetId: string): void => {
      if (presetId === 'custom') {
        setEditing((prev) => (prev ? { ...prev, presetId } : prev))
        return
      }
      const p = PRESETS.find((x) => x.id === presetId)
      if (!p) return
      setDraftFetchedModels([])
      setEditing((prev) =>
        prev ? { ...prev, presetId, name: p.name, provider: p.provider, baseURL: p.baseURL, model: p.models[0] ?? '' } : prev,
      )
      setTestResult(null)
    }

    const suggestionList =
      draftFetchedModels.length > 0
        ? draftFetchedModels
        : editing.id && fetchedByProfile[editing.id]?.length
          ? fetchedByProfile[editing.id]
          : preset.models.map((m) => ({ id: m, name: undefined }))

    return (
      <div className="settings-page">
        <h2>{editing.id ? '编辑配置档' : '新增配置档'}</h2>

        <label className="field">
          <span>预设（快速填入主流模型厂商与网关）</span>
          <select value={editing.presetId} onChange={(e) => applyPreset(e.target.value)}>
            {PRESET_GROUPS.map((groupName) => (
              <optgroup key={groupName} label={groupName}>
                {PRESETS.filter((p) => p.group === groupName).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {preset.docsURL ? (
          <div className="docs-link">
            官方文档（获取 API Key / 模型列表 / 定价）：
            <a href={preset.docsURL} target="_blank" rel="noreferrer">
              {preset.docsURL}
            </a>
          </div>
        ) : null}

        <label className="field">
          <span>配置名称</span>
          <input
            value={editing.name}
            placeholder="例如 DeepSeek / 通义千问 / Gemini"
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>协议类型</span>
          <select
            value={editing.provider}
            onChange={(e) => setEditing({ ...editing, provider: e.target.value as ProviderType })}
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            value={editing.baseURL}
            placeholder={providerOption.baseURLPlaceholder}
            onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })}
          />
        </label>

        <div className="field">
          <span>模型</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={editing.model}
              list="model-suggestions"
              placeholder={providerOption.modelPlaceholder}
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
            />
            <button
              type="button"
              className="btn"
              disabled={fetchingModels}
              onClick={() => void fetchModelsInDraft()}
              title="从服务商接口拉取模型列表"
            >
              <Icon name="refresh" size={14} />
              {fetchingModels ? '拉取中…' : '拉取模型'}
            </button>
          </div>
          <datalist id="model-suggestions">
            {suggestionList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? ''}
              </option>
            ))}
          </datalist>
        </div>

        <label className="field">
          <span>上下文容量覆盖（tokens，可选）</span>
          <input type="number" min="1" step="1" value={editing.contextWindowOverride}
            placeholder="留空，从服务元数据或已核实的官方配置获取"
            onChange={(e) => setEditing({ ...editing, contextWindowOverride: e.target.value })} />
          <small>只有需要手动指定时填写；容量详情会明确标为手动配置。</small>
        </label>

        <label className="field">
          <span>API Key{editing.provider === 'ollama' ? '（本地可留空）' : ''}</span>
          <input
            type="password"
            value={editing.apiKey}
            placeholder={
              editing.hasApiKey
                ? `已保存 ${editing.apiKeyHint}（留空则保持不变）`
                : editing.provider === 'ollama'
                  ? '本地 Ollama 可留空；远程服务请填写密钥'
                  : 'sk-… / AIza…'
            }
            onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
          />
          <small>密钥经 Electron safeStorage 加密后保存在本地，不会原样出现在配置里。</small>
        </label>

        <label className="field">
          <span>HTTP 代理（可选，留空直连）</span>
          <input
            value={editing.proxyURL}
            placeholder="例如 http://127.0.0.1:7890"
            onChange={(e) => setEditing({ ...editing, proxyURL: e.target.value })}
          />
          <small>填写后该配置档的所有 API 请求经此代理发送（http/https 代理）；留空则直连。</small>
        </label>

        <SettingsNotice notice={testResult} />

        <div className="settings-page-actions">
          <button className="btn" disabled={testing} onClick={() => void test()}>
            <Icon name="refresh" size={14} />{testing ? '测试中…' : '测试连接'}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => setEditing(null)}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    )
  }

  // ---------- 列表视图 ----------
  return (
    <div className="settings-page">
      <h2>LLM 配置</h2>
      <p className="hint-line">
        支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Claude、Google Gemini 原生、Azure OpenAI、Ollama 原生、Cohere V2 等主流协议，可在输入框下方随时切换。
      </p>

      {llmProfiles.length === 0 ? (
        <div className="profile-empty">还没有模型配置。添加服务商与 API Key，即可开始对话。</div>
      ) : (
        <>
          <div className="profile-list">
            {llmProfiles.map((p) => (
              <div key={p.id} className={`profile-row ${p.id === activeLlmId ? 'active' : ''}`}>
                <div className="profile-info">
                  <span className="profile-name">{p.name}</span>
                  <small>
                    {providerShortLabel(p.provider)} · {p.model || '(未设模型)'} ·{' '}
                    {p.hasApiKey ? `密钥 ${p.apiKeyHint}` : p.provider === 'ollama' ? '本地免密' : '未设密钥'}
                  </small>
                  <small>
                    上下文：{p.contextInfo ? `${p.contextInfo.contextWindow.toLocaleString()} tokens · ${p.contextInfo.source === 'api' ? '服务元数据' : p.contextInfo.source === 'manual' ? '手动配置' : '官方文档'}` : '上限未确认'}
                    {balanceFor[p.id] ? (() => {
                      const b = balanceFor[p.id]
                      return b.ok
                        ? ` · 余额：${b.currency === 'USD' ? '$' : b.currency === 'CNY' ? '¥' : ''}${b.totalBalance ?? '?'}${b.grantedBalance && b.grantedBalance !== '0' ? ` · 赠送 ${b.grantedBalance}` : ''}${b.isAvailable === false ? ' · 账户不可用' : ''}`
                        : ` · 余额查询失败：${b.error ?? '未知原因'}`
                    })() : null}
                  </small>
                  {rowNotice?.profileId === p.id ? (
                    <small className={rowNotice.tone === 'success' ? 'status-line status-success' : 'status-line status-error'} style={{ display: 'block' }}>
                      {rowNotice.text}
                    </small>
                  ) : null}
                </div>
                <div className="profile-actions">
                  <div className="mode-menu-wrap">
                    <button className="btn" onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}>
                      操作 ▾
                    </button>
                    {menuFor === p.id ? (
                      <div className="mode-menu profile-menu">
                        <button className="mode-item" disabled={fetchingModels} onClick={() => {
                          setMenuFor(null)
                          void fetchModelsFor(p)
                        }}>
                          获取模型列表
                        </button>
                        <button className="mode-item" disabled={refreshingContext !== null} onClick={() => {
                          setMenuFor(null)
                          setRefreshingContext(p.id)
                          void actions.refreshModelContext(p.id).then((result) => {
                            setRefreshingContext(null)
                            setRowNotice({ profileId: p.id, tone: result.ok ? 'success' : 'warning', text: result.message })
                          })
                        }}>
                          获取容量
                        </button>
                        <button
                          className="mode-item"
                          disabled={balanceBusy}
                          onClick={() => {
                            setMenuFor(null)
                            void queryBalanceFor(p.id)
                          }}
                        >
                          查询余额
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button className="btn" onClick={() => startEdit(p)}>
                    <Icon name="edit" size={14} />编辑
                  </button>
                  <button className="btn btn-danger-ghost" onClick={() => void remove(p)}>
                    <Icon name="trash" size={14} />删除
                  </button>
                  <label
                    className="llm-switch"
                    title={p.enabled !== false ? '展示在聊天框的模型选择列表中（点击隐藏）' : '已隐藏，点击展示到模型选择列表'}
                  >
                    <input
                      type="checkbox"
                      checked={p.enabled !== false}
                      onChange={(e) => void actions.setProfileEnabled(p.id, e.target.checked)}
                    />
                    <span className="track"><span className="knob" /></span>
                  </label>
                </div>
              </div>
            ))}
          </div>

        </>
      )}

      <div className="settings-page-actions">
        <button className="btn btn-primary" onClick={startNew}>
          <Icon name="plus" size={14} />新增配置
        </button>
        <div className="spacer" />
        {saved ? <span className="saved-hint" role="status"><Icon name="check" size={14} />已保存</span> : null}
      </div>
    </div>
  )
}
