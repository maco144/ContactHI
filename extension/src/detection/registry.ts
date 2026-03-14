import type { DetectionPlugin } from './plugin.js'

const plugins = new Map<string, DetectionPlugin>()

export function registerPlugin(plugin: DetectionPlugin): void {
  plugins.set(plugin.name, plugin)
}

export function getPlugin(name: string): DetectionPlugin | undefined {
  return plugins.get(name)
}

export function listPlugins(): string[] {
  return Array.from(plugins.keys())
}
