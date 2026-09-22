import { createTheme } from "@mantine/core";

export const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  primaryColor: "blue",
  primaryShade: 8,
  defaultRadius: "sm",
  headings: { fontFamily: 'Inter, sans-serif', fontWeight: "600", sizes: { h1: { fontSize: "1.5rem" }, h2: { fontSize: "1.375rem" }, h3: { fontSize: "1.125rem" } } },
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px" },
  components: {
    Button: { defaultProps: { size: "sm" } },
    ActionIcon: { defaultProps: { size: 44 } },
    Badge: { defaultProps: { variant: "outline", radius: "sm" } },
    Alert: { defaultProps: { variant: "outline", radius: "sm" } },
    TextInput: { defaultProps: { size: "md" } },
    Textarea: { defaultProps: { size: "md" } },
    NativeSelect: { defaultProps: { size: "md" } },
  },
});
