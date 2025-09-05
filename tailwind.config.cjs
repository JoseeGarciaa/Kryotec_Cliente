/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.ejs',
    './public/**/*.js'
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      keyframes: {
        'fade-in': { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        'fade-out': { '0%': { opacity: 1 }, '100%': { opacity: 0 } },
        'slide-up': { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'fade-out': 'fade-out 160ms ease-in',
        'slide-up': 'slide-up 220ms ease-out',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        kryoDark: {
          ...require('daisyui/src/theming/themes')['dark'],
          primary: '#6D4AFF',
          secondary: '#A78BFA',
          accent: '#60A5FA',
          'base-100': '#0b1220',
          'base-200': '#0f172a',
          'base-300': '#1f2937',
        },
      },
      {
        kryoLight: {
          ...require('daisyui/src/theming/themes')['light'],
          primary: '#4F46E5',
          secondary: '#8B5CF6',
          accent: '#38BDF8',
          'base-100': '#f8fafc',
          'base-200': '#ffffff',
          'base-300': '#e5e7eb',
        },
      },
    ],
  },
};
