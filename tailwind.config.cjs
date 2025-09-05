/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.ejs',
    './public/**/*.js'
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: { extend: {} },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        kryoDark: {
          ...require('daisyui/src/theming/themes')['dark'],
          primary: '#6d6fff',
          secondary: '#a78bfa',
          accent: '#4f46e5',
          'base-100': '#0f172a',
          'base-200': '#111827',
          'base-300': '#1f2937',
        },
      },
      {
        kryoLight: {
          ...require('daisyui/src/theming/themes')['light'],
          primary: '#4f46e5',
          secondary: '#8b5cf6',
          accent: '#4338ca',
          'base-100': '#f7f8fb',
          'base-200': '#ffffff',
          'base-300': '#e5e7eb',
        },
      },
    ],
  },
};
