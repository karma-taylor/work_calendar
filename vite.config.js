import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    // 与 start-work-calendar.bat 中 http://localhost:5173 一致，避免 localhost / 127.0.0.1 两套 localStorage
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
})
