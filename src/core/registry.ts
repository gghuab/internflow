import type { GeneratorPlugin, SinkPlugin, SourcePlugin } from './types.js';
import { CodexGenerator } from '../plugins/generators/codex.js';
import { CodexSource } from '../plugins/sources/codex.js';
import { LarkSink } from '../plugins/sinks/lark.js';
import { MarkdownSink } from '../plugins/sinks/markdown.js';

export class PluginRegistry {
  readonly sources = new Map<string, SourcePlugin>();
  readonly generators = new Map<string, GeneratorPlugin>();
  readonly sinks = new Map<string, SinkPlugin>();

  constructor() {
    this.sources.set('codex', new CodexSource());
    this.generators.set('codex', new CodexGenerator());
    this.sinks.set('markdown', new MarkdownSink());
    this.sinks.set('lark', new LarkSink());
  }

  source(name: string): SourcePlugin {
    const plugin = this.sources.get(name);
    if (!plugin) throw new Error(`Unknown source plugin: ${name}`);
    return plugin;
  }

  generator(name: string): GeneratorPlugin {
    const plugin = this.generators.get(name);
    if (!plugin) throw new Error(`Unknown generator plugin: ${name}`);
    return plugin;
  }

  sink(name: string): SinkPlugin {
    const plugin = this.sinks.get(name);
    if (!plugin) throw new Error(`Unknown sink plugin: ${name}`);
    return plugin;
  }
}

