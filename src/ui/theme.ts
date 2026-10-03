import { createTheme, type MantineColorsTuple } from "@mantine/core";

// One accent blue everywhere (Mantine shade 8 used to be #1971c2 while the CSS accent was #1859b7).
const blue: MantineColorsTuple = ["#e8f0fb", "#d2e1f6", "#a6c3ec", "#77a3e1", "#5088d8", "#3878d2", "#2a6ecf", "#1f60bb", "#1859b7", "#144a98"];
// Shade 8 is the solid fill and danger text; #c92a2a keeps white text at 5.46:1.
const red: MantineColorsTuple = ["#fff5f5", "#ffe3e3", "#ffc9c9", "#ffa8a8", "#ff8787", "#ff6b6b", "#fa5252", "#e03131", "#c92a2a", "#a51d1d"];
const green: MantineColorsTuple = ["#ebfbee", "#d3f9d8", "#b2f2bb", "#8ce99a", "#69db7c", "#51cf66", "#40c057", "#2f9e44", "#198038", "#14692e"];

export const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  primaryColor: "blue",
  primaryShade: 8,
  colors: { blue, red, green },
  defaultRadius: "sm",
  headings: { fontFamily: 'Inter, sans-serif', fontWeight: "600", sizes: { h1: { fontSize: "1.5rem" }, h2: { fontSize: "1.375rem" }, h3: { fontSize: "1.125rem" } } },
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px" },
  components: {
    Button: { defaultProps: { size: "sm" } },
    // Mantine's default is hover-only; keyboard users must reach the same explanations.
    Tooltip: { defaultProps: { events: { hover: true, focus: true, touch: false } } },
    ActionIcon: { defaultProps: { size: 44 } },
    Badge: { defaultProps: { variant: "outline", radius: "sm" } },
    Alert: { defaultProps: { variant: "outline", radius: "sm" } },
    TextInput: { defaultProps: { size: "md" } },
    Textarea: { defaultProps: { size: "md" } },
    NativeSelect: { defaultProps: { size: "md" } },
  },
});
