import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Users\\test\\AppData\\Roaming\\StableWorker' },
  ipcMain: { handle: () => undefined },
  dialog: {},
  shell: {},
}))

import { parseDurationMs, parseStoryboard, segmentArgs, getVideoToolDefinitions } from '../src/main/tools/video'
import { toolsForTaskMode, videoSystemPrompt } from '../src/main/officeMode'
import type { ToolDefinition } from '../src/main/tools'

const tool = (name: string): ToolDefinition => ({ name, description: '', inputSchema: {}, execute: async () => ({ content: '' }) })

describe('分镜脚本校验', () => {
  it('接受合法分镜并补齐字段', () => {
    const sb = parseStoryboard({
      scenes: [
        { image: 'inputs/a.jpg', text: '第一镜头', duration: 2 },
        { audio: 'outputs/voice-002.mp3' },
      ],
      voice: 'zh-CN-YunxiNeural',
    })
    expect(sb.scenes).toHaveLength(2)
    expect(sb.scenes[0]).toEqual({ image: 'inputs/a.jpg', text: '第一镜头', duration: 2 })
    expect(sb.scenes[1].duration).toBeUndefined()
    expect(sb.voice).toBe('zh-CN-YunxiNeural')
  })
  it('拒绝空镜头、越界路径、坏扩展名与非法时长', () => {
    expect(() => parseStoryboard({ scenes: [] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ image: 'C:/abs/path.jpg' }] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ image: '../escape.png' }] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ image: 'inputs/movie.mp4' }] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ duration: 0.1 }] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ duration: 601 }] })).toThrow()
    expect(() => parseStoryboard({ scenes: [{ text: 'x'.repeat(2001) }] })).toThrow()
    expect(() => parseStoryboard({ scenes: 'x' })).toThrow()
    expect(() => parseStoryboard(null)).toThrow()
  })
  it('镜头数量上限 200', () => {
    expect(() => parseStoryboard({ scenes: Array.from({ length: 201 }, () => ({ duration: 1 })) })).toThrow(/200/)
  })
})

describe('ffmpeg 参数构建与时长解析', () => {
  it('图片镜头：缩放补边 + 字幕烧录 + 指定时长', () => {
    const args = segmentArgs({ image: 'D:/t/inputs/a.jpg', audio: 'D:/t/outputs/voice-001.mp3', durationSec: 4.2, subtitleFile: 'D:/t/outputs/.work/sub-001.txt', fontFile: 'C:\\Windows\\Fonts\\msyh.ttc', segmentPath: 'D:/t/outputs/.work/segments/scene-001.mp4' })
    expect(args).toContain('-loop')
    expect(args.join(' ')).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(args.join(' ')).toContain('drawtext=')
    expect(args.join(' ')).toContain("fontfile='C\\:/Windows/Fonts/msyh.ttc'")
    expect(args[args.indexOf('-t') + 1]).toBe('4.2')
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
  })
  it('无图用纯色底、无音频补静音轨', () => {
    const withAudio = segmentArgs({ audio: 'D:/t/v.mp3', durationSec: 3, segmentPath: 's.mp4' })
    expect(withAudio.join(' ')).toContain('color=c=0x101820')
    expect(withAudio.join(' ')).not.toContain('drawtext')
    const silent = segmentArgs({ durationSec: 3, segmentPath: 's.mp4' })
    expect(silent.join(' ')).toContain('anullsrc=r=44100:cl=stereo')
    expect(silent.join(' ')).toContain('color=c=0x101820')
  })
  it('从 ffmpeg stderr 解析时长；解析不出返回 null', () => {
    expect(parseDurationMs('Input #0…\n  Duration: 00:00:03.24, start: 0.000000, bitrate: 48 kb/s\n')).toBe(3240)
    expect(parseDurationMs('  Duration: 01:00:00.00, start: 0\n')).toBe(3_600_000)
    expect(parseDurationMs('没有时长信息')).toBeNull()
  })
})

describe('视频模式工具面', () => {
  it('只开放协作白名单加视频与流水线工具，不泄露编码写入/命令工具', () => {
    const base = ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'web_fetch', 'todo_write', 'ask_user_question', 'memory', 'web_search'].map(tool)
    const videoTools = getVideoToolDefinitions().map((t) => t.name)
    expect(videoTools).toEqual(['video_tts', 'video_compose', 'video_files', 'pipeline_write', 'pipeline_run', 'pipeline_read'])
    const pool = toolsForTaskMode('video', base, [], getVideoToolDefinitions()).map((t) => t.name)
    expect(pool).toEqual(['web_fetch', 'todo_write', 'ask_user_question', 'memory', 'web_search', ...videoTools])
    expect(pool).not.toContain('write_file')
    expect(pool).not.toContain('run_command')
  })
  it('video_compose 需要批准（终产物门禁），video_tts 随编辑模式放行', () => {
    const defs = Object.fromEntries(getVideoToolDefinitions().map((t) => [t.name, t]))
    expect(defs.video_compose.requiresApproval).toBe(true)
    expect(defs.video_compose.kind).toBe('edit')
    expect(defs.video_tts.requiresApproval).toBeFalsy()
  })
  it('系统提示词包含工作区、分镜格式与完成判据', () => {
    const prompt = videoSystemPrompt('/fixture/video/task')
    expect(prompt).toContain('/fixture/video/task')
    expect(prompt).toContain('zh-CN-XiaoxiaoNeural')
    expect(prompt).toContain('video_tts')
    expect(prompt).toContain('video_compose')
    expect(prompt).toContain('只有 video_compose 返回成功才可宣称视频完成')
  })
})
