// Order matters: the secure random source must exist before any module that
// mints keys or request ids is evaluated.
import "./src/lib/polyfills";
import "expo-router/entry";
