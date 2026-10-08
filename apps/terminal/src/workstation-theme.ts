import type { ChartTheme } from '@tradescript/pro/sdk'
import type { Appearance } from './appearance.js'

function glassTheme(appearance: Appearance): ChartTheme {
  const light = appearance === 'light'
  const text = light ? '#25262b' : '#ececf0'
  const mutedText = light ? '#65666e' : '#a5a6af'
  const subtleText = light ? '#8a8b94' : '#757680'
  const headingText = light ? '#17181c' : '#fafafd'
  const border = light ? 'rgba(40, 40, 40, 0.12)' : 'rgba(255, 255, 255, 0.13)'
  const divider = light ? 'rgba(40, 40, 40, 0.08)' : 'rgba(255, 255, 255, 0.08)'
  const accent = light ? '#626262' : '#c4c4c4'
  const selectedBackground = light ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.12)'
  const selectedBorder = light ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.34)'
  const secondaryButton = {
    background: '#3d3d3d',
    border: '#626262',
    text: '#ffffff',
    hoverBackground: '#4b4b4b',
    hoverBorder: '#7b7b7b',
    hoverText: '#ffffff',
  }
  const primaryButton = {
    background: '#ffffff',
    border: '#ffffff',
    text: '#111111',
    hoverBackground: '#ededed',
    hoverBorder: '#ededed',
    hoverText: '#111111',
  }
  const positive = '#24ea85'
  const positiveText = light ? '#087b40' : positive
  const positiveButton = {
    background: positive,
    border: positive,
    text: '#072316',
    hoverBackground: '#20d67a',
    hoverBorder: '#20d67a',
    hoverText: '#072316',
  }
  const negative = light ? '#c23e46' : '#fb7c85'

  return {
    base: appearance,
    name: `IBKR Terminal Glass ${light ? 'Light' : 'Dark'}`,
    colors: {
      background: light ? '#f7f7f9' : '#191a1f',
      gridHorizontal: light ? 'rgba(90, 93, 107, 0.09)' : 'rgba(185, 187, 199, 0.075)',
      gridVertical: light ? 'rgba(90, 93, 107, 0.06)' : 'rgba(185, 187, 199, 0.052)',
      gridVerticalMinor: light ? 'rgba(90, 93, 107, 0.035)' : 'rgba(185, 187, 199, 0.028)',
      gridVerticalMajor: light ? 'rgba(90, 93, 107, 0.1)' : 'rgba(185, 187, 199, 0.08)',
      text,
      upColor: positive,
      downColor: negative,
      upWickColor: positive,
      downWickColor: negative,
      upBorderColor: positive,
      downBorderColor: negative,
      crosshairColor: light ? 'rgba(69, 75, 88, 0.45)' : 'rgba(200, 202, 215, 0.45)',
      crosshairLabelBackground: '#4b4b4b',
      axisLineColor: border,
      axisTextColor: mutedText,
      axisBackgroundColor: light ? '#f4f4f7' : '#1b1c22',
      paneSeparatorColor: divider,
    },
    ui: {
      surface: {
        background: light ? 'rgba(255, 255, 255, 0.84)' : 'rgba(30, 31, 37, 0.86)',
        shellBackground: 'transparent',
        border,
        borderRadius: '16px',
        text,
        mutedText,
        subtleText,
        headingText,
        divider,
        hoverBackground: light ? 'rgba(30, 35, 48, 0.045)' : 'rgba(255, 255, 255, 0.055)',
        selectedBackground,
        selectedBorder,
        selectedText: headingText,
        activeBackground: light ? 'rgba(0, 0, 0, 0.045)' : 'rgba(255, 255, 255, 0.075)',
        activeBorder: light ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.24)',
        shadow: light ? '0 16px 40px rgba(25, 28, 40, 0.1)' : '0 18px 46px rgba(0, 0, 0, 0.3)',
      },
      button: {
        background: 'transparent',
        border,
        text,
        icon: text,
        hoverBackground: 'transparent',
        hoverBorder: border,
        hoverText: text,
        hoverIcon: text,
        selectedBackground: '#5b5b5b',
        selectedBorder: '#8a8a8a',
        selectedText: '#ffffff',
        selectedIcon: '#ffffff',
        selectedOverlay: 'none',
        selectedShine: 'none',
        selectedShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        overlay: 'none',
        shadow: 'none',
        disabledBackground: 'transparent',
        disabledBorder: divider,
        disabledText: light ? '#909090' : '#777777',
        disabledIcon: light ? '#909090' : '#777777',
      },
      control: {
        background: light ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.055)',
        border,
        text,
        placeholderText: subtleText,
        hoverBackground: light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.085)',
        hoverBorder: light ? 'rgba(40, 40, 40, 0.22)' : 'rgba(255, 255, 255, 0.22)',
        focusBorder: accent,
        disabledBackground: light ? 'rgba(235, 235, 240, 0.62)' : 'rgba(255, 255, 255, 0.025)',
        disabledBorder: light ? 'rgba(40, 40, 40, 0.06)' : 'rgba(255, 255, 255, 0.06)',
        disabledText: light ? '#95969e' : '#696a75',
        radius: '10px',
        pillRadius: '999px',
      },
      checkbox: {
        background: light ? '#ffffff' : '#303030',
        border,
        hoverBorder: accent,
        checkedBackground: '#5b5b5b',
        checkedBorder: '#8a8a8a',
        checkColor: '#ffffff',
        checkedOverlay: 'none',
        disabledBackground: light ? '#e5e5e5' : '#2b2b2b',
        disabledBorder: border,
        disabledCheckColor: light ? '#909090' : '#777777',
      },
      radio: {
        background: light ? '#ffffff' : '#303030',
        border,
        hoverBorder: accent,
        checkedBackground: '#5b5b5b',
        checkedBorder: '#8a8a8a',
        dotColor: '#ffffff',
        disabledBackground: light ? '#e5e5e5' : '#2b2b2b',
        disabledBorder: border,
      },
      modal: {
        backdrop: light ? 'rgba(32, 35, 44, 0.17)' : 'rgba(5, 6, 10, 0.38)',
        background: light ? 'rgba(248, 248, 251, 0.94)' : 'rgba(35, 36, 43, 0.94)',
        border: light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.18)',
        shadow: light
          ? '0 30px 90px rgba(28, 31, 44, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.95)'
          : '0 30px 90px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
        text,
        mutedText,
        titleText: headingText,
        headerBackground: 'transparent',
        headerBorder: divider,
        footerBorder: divider,
      },
      semantic: {
        accent,
        positive,
        positiveBackground: light ? 'rgba(36, 234, 133, 0.08)' : 'rgba(36, 234, 133, 0.1)',
        positiveText,
        positiveOnText: '#072316',
        negative,
        negativeBackground: light ? 'rgba(194, 62, 70, 0.08)' : 'rgba(251, 124, 133, 0.1)',
        negativeBorder: light ? 'rgba(194, 62, 70, 0.24)' : 'rgba(251, 124, 133, 0.28)',
        negativeText: negative,
        negativeOnText: light ? '#ffffff' : '#33090d',
        warning: light ? '#9c6b09' : '#e9b965',
      },
      depth: {
        bid: positive,
        bidText: positiveText,
        bidFill: light ? 'rgba(36, 234, 133, 0.075)' : 'rgba(36, 234, 133, 0.08)',
        bidOrderBackground: light ? 'rgba(36, 234, 133, 0.13)' : 'rgba(36, 234, 133, 0.16)',
        bidOrderText: positiveText,
        ask: negative,
        askText: negative,
        askFill: light ? 'rgba(194, 62, 70, 0.065)' : 'rgba(251, 124, 133, 0.08)',
        askOrderBackground: light ? 'rgba(194, 62, 70, 0.12)' : 'rgba(251, 124, 133, 0.16)',
        askOrderText: light ? '#942730' : '#ffc3ca',
        priceText: text,
        spreadPriceText: mutedText,
        headerText: mutedText,
        rowDivider: divider,
        columnDivider: divider,
        rowHoverBackground: light ? 'rgba(0, 0, 0, 0.035)' : 'rgba(255, 255, 255, 0.055)',
        spreadDivider: border,
        scrollbarThumb: light ? 'rgba(40, 40, 40, 0.19)' : 'rgba(255, 255, 255, 0.17)',
        currentBackground: selectedBackground,
        currentBorder: selectedBorder,
        currentText: headingText,
        upFlash: light ? 'rgba(36, 234, 133, 0.14)' : 'rgba(36, 234, 133, 0.2)',
        downFlash: light ? 'rgba(194, 62, 70, 0.14)' : 'rgba(251, 124, 133, 0.2)',
      },
      buttonPositive: positiveButton,
      buttonNegative: secondaryButton,
      buttonHighlight: primaryButton,
      focus: {
        ring: light ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.6)',
        inputRing: light ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.26)',
      },
      loader: { color: accent, track: border },
      marker: { background: '#5b5b5b', border: '#8a8a8a', text: '#ffffff' },
      typography: {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, ui-sans-serif, "Segoe UI", sans-serif',
        monoFontFamily: '"SF Mono", "Roboto Mono", ui-monospace, monospace',
        fontSize: '12px',
        fontWeight: '450',
      },
      chrome: {
        favoriteSweep: 'none',
        selectionCardSheen: 'none',
        drawingSidebarOverflowBorder: border,
        drawingSidebarOverflowBackground: light
          ? 'rgba(250, 250, 253, 0.96)'
          : 'rgba(35, 36, 43, 0.96)',
        drawingSidebarOverflowHoverBackground: light ? '#efeff4' : '#303139',
      },
    },
  }
}

export const WORKSTATION_THEMES: Record<Appearance, ChartTheme> = {
  light: glassTheme('light'),
  dark: glassTheme('dark'),
}

function accountPanelTheme(appearance: Appearance): ChartTheme {
  const theme = WORKSTATION_THEMES[appearance]
  const border = appearance === 'light' ? 'rgba(40, 40, 40, 0.14)' : 'rgba(255, 255, 255, 0.14)'
  return {
    ...theme,
    ui: {
      ...theme.ui,
      button: {
        ...theme.ui?.button,
        border,
        hoverBorder: border,
        selectedBackground: '#383838',
        selectedBorder: 'rgba(255, 255, 255, 0.22)',
        selectedShadow: 'none',
      },
    },
  }
}

export const WORKSTATION_ACCOUNT_THEMES: Record<Appearance, ChartTheme> = {
  light: accountPanelTheme('light'),
  dark: accountPanelTheme('dark'),
}
