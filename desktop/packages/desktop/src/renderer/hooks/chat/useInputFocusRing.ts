import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';

export const useInputFocusRing = () => {
  const { theme } = useThemeContext();
  const isDarkTheme = theme === 'dark';

  return {
    // The mu colour scheme defines the tokens; without it the upstream values apply.
    activeBorderColor: `var(--mu-input-border-active, ${isDarkTheme ? '#4D4B87' : '#E1E0FF'})`,
    inactiveBorderColor: `var(--mu-input-border, ${isDarkTheme ? '#3a3a4a' : '#c9cacf'})`,
    activeShadow: `var(--mu-input-shadow-active, ${
      isDarkTheme ? '0px 2px 20px rgba(77, 75, 135, 0.45)' : '0px 2px 20px rgba(225, 224, 255, 0.6)'
    })`,
  };
};
