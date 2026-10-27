/// <reference types="vite/client" />
// Bundles every theme file. Kept apart from theme.ts because Vite hoists an eager glob to the top
// of its module, and theme.ts must load the base sheet before the themes.
import.meta.glob('./themes/*.css', { eager: true })
