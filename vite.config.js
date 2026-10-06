import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:8080',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'pages/admin.html'),
        superadmin: resolve(__dirname, 'pages/superadmin.html'),
        participant: resolve(__dirname, 'pages/participant.html'),
        team: resolve(__dirname, 'pages/team.html'),
        monitor: resolve(__dirname, 'public/camera-monitor.html'),
        livefeed: resolve(__dirname, 'public/live-feed.html'),
      },

    },
  },
});
