import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // The sim must stay deterministic: use the seeded RNG in SimState instead.
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded RNG (@sim/rng)." },
      ],
    },
  },
  prettier,
);
