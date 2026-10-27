// The root type check reaches mod/hooks/i18n.ts through mcp/server.ts and the main
// process. The engine types ship with Claude Code and are checked by the mod's own
// type check; here the one name i18n.ts imports stays loose.
declare module 'claude-code' {
  export type EngineInterface = any
}
