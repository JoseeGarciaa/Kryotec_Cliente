/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.ejs',
    './public/**/*.js'
  ],
  darkMode: 'class',
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
      colors: {
        primary: {
          50: '#E7F1FF',
          100: '#D3E5FF',
          200: '#BCCFFF',
          300: '#93ACFF',
          400: '#4F78FF',
          500: '#2743FF',
          600: '#0135FF',
          700: '#0018FF',
          800: '#0012A4',
          900: '#0A0B8B',
          950: '#07083F',
        },
        light: {
          bg: '#FFFFFF',
          card: '#F8FAFC',
          border: '#E2E8F0',
          text: '#1E293B',
        },
        dark: {
          bg: '#0F172A',
          card: '#1E293B',
          border: '#334155',
          text: '#F8FAFC',
        },
      },
      backgroundColor: {
        'blue-light': '#E7F1FF',
        'blue-medium': '#93ACFF',
        'blue-dark': '#0135FF',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        kryoDark: {
          ...require('daisyui/src/theming/themes')['dark'],
          primary: '#2743FF',
          secondary: '#93ACFF',
          accent: '#4F78FF',
          'base-100': '#0F172A',
          'base-200': '#1E293B',
          'base-300': '#334155',
        },
      },
      {
        kryoLight: {
          ...require('daisyui/src/theming/themes')['light'],
          primary: '#2743FF',
          secondary: '#93ACFF',
          accent: '#4F78FF',
          'base-100': '#FFFFFF',
          'base-200': '#F8FAFC',
          'base-300': '#E2E8F0',
        },
      },
    ],
  },
};
