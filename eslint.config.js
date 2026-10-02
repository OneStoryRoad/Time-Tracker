import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, {
  files: ["web/**/*.{ts,tsx}"],
  rules: { "@typescript-eslint/no-explicit-any": "error" },
});
