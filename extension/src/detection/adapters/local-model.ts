/* eslint-disable @typescript-eslint/no-explicit-any */
import { pipeline, env } from '@huggingface/transformers'
import type { DetectionPlugin, DetectionRequest, DetectionResult } from '../plugin.js'

const MODEL_ID = 'Xenova/roberta-base-openai-detector'

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: number; file: string }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; message: string }

async function setModelStatus(status: ModelStatus): Promise<void> {
  await chrome.storage.local.set({ modelStatus: status })
  chrome.runtime.sendMessage({ type: 'MODEL_STATUS', status }).catch(() => {})
}

export class LocalModelAdapter implements DetectionPlugin {
  readonly name = 'local-model'
  readonly version = '1.0.0'

  private classifierPromise: Promise<any> | null = null

  configure(_config: Record<string, string>): void {}

  isConfigured(): boolean {
    return true
  }

  private getClassifier(): Promise<any> {
    if (this.classifierPromise) return this.classifierPromise

    // Point WASM runtime to locally bundled files — no network call for the runtime
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('dist/ort/')
    }
    // Models cached in Cache API after first download
    env.useBrowserCache = true

    this.classifierPromise = (async () => {
      try {
        await setModelStatus({ state: 'loading' })

        const classifier = await pipeline('text-classification', MODEL_ID, {
          progress_callback: async (p: any) => {
            if (p.status === 'downloading') {
              await setModelStatus({
                state: 'downloading',
                progress: typeof p.progress === 'number' ? Math.round(p.progress) : 0,
                file: typeof p.file === 'string' ? p.file.split('/').pop() ?? p.file : '',
              })
            } else if (p.status === 'loading') {
              await setModelStatus({ state: 'loading' })
            }
          },
        })

        await setModelStatus({ state: 'ready' })
        return classifier
      } catch (err) {
        const message = String(err)
        await setModelStatus({ state: 'error', message })
        this.classifierPromise = null
        throw err
      }
    })()

    return this.classifierPromise
  }

  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const classifier = await this.getClassifier()

    // RoBERTa max 512 tokens — truncate conservatively (~4 chars/token)
    const text = request.text.slice(0, 1800)

    const output: any = await classifier(text, { truncation: true, max_length: 512 })
    const top = Array.isArray(output) ? output[0] : output

    // Xenova/roberta-base-openai-detector labels: 'Real' (human) | 'Fake' (AI)
    const isAI = top.label === 'Fake' || top.label === 'LABEL_1'
    const confidence = isAI ? top.score : 1 - top.score

    return {
      isAI,
      confidence: parseFloat(confidence.toFixed(2)),
      provider: 'local-model',
      modelDetected: isAI ? 'ai-generated' : undefined,
    }
  }
}
