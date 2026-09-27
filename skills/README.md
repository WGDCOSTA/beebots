# Importable skills

Every `*.json` file in this folder is loaded as trading skills for the strategy lab (`pnpm lab skills` lists them,
`pnpm lab run` simulates them next to the built-in ones). Add more folders with `SKILLS_DIRS=./skills,/path/to/more`.

A file holds one skill, an array of skills, or a pack `{ "skills": [ ... ] }`. The rule language is documented at the
top of [`src/lab/skills/dsl.ts`](../src/lab/skills/dsl.ts); `classic-pack.json`, `freqtrade-style-pack.json` (with Freqtrade-style `roi` / `stoploss` / `trailing` exits) and
`backtrader-samples-pack.json` have worked examples.

A skill only ever reaches a bee after it has been ranked on walk-forward out-of-sample data and a bee's brain picked
it in the council. Even then it is one vote Jev may weigh, never an order.
