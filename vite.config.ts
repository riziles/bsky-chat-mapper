import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/bsky-chat-mapper/',
  plugins: [preact()],
})
