import neostandard from "neostandard";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...neostandard({
    ts: true,
    noStyle: true,
    ignores: ["dist/**"],
  }),
  reactHooks.configs.flat["recommended-latest"],
];
