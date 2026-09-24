# pi-dev-autocorrect

A British-English spell checker / autocorrector for the [pi coding agent](https://github.com/earendil-works/pi).

It checks every prompt before it is sent and either shows possible spelling
mistakes, fixes them automatically, or asks for confirmation — your choice.

## Modes

| Mode   | Behaviour                                                                 |
| ------ | ------------------------------------------------------------------------- |
| `warn` | Show possible mistakes with suggestions; send the prompt unchanged (default) |
| `fix`  | Auto-apply *confident* corrections and report what was changed            |
| `ask`  | Show a picker for each misspelled word before sending                     |
| `off`  | Disabled (status bar shows nothing)                                       |

"Confident" fixes must win their (edit-distance, word-length) group outright,
with a common-word tiebreak — `teh → the`, `recieve → receive`, `becuase →
because` get fixed; ambiguous short words are only reported.

## Code-aware checking

Prompts to a coding agent are full of things that aren't prose. The tokenizer
skips:

- fenced code blocks and `` `inline code` ``
- URLs, e-mail addresses
- file paths (`/usr/local/...`, `src/lib/foo.ts`)
- CLI flags (`--force`, `-rf`)
- `snake_case` and `camelCase` identifiers, dotted names (`package.json`)
- ALL-CAPS constants and acronyms (`JSONParser`, `HTTP_TIMEOUT`)
- very short words (< 3 chars)

Possessives are checked via their base (`user's` → `user`), hyphenated
compounds per part (`well-known`), and suggestions preserve your casing
(`Recieve → Receive`).

## Commands

- `/spell` — spell-check the current draft in the editor, offer to apply fixes
- `/spell-mode [off|warn|fix|ask]` — switch mode (interactive picker without an argument)
- `/spell-add <word…>` — add words to your personal dictionary
- `/spell-remove <word…>` — remove them again

## Dictionaries

| File                    | Contents                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `dict/british-english`  | Standard British word list (~73k words)                          |
| `dict/tech-words.txt`   | **Generated** — technical vocabulary merged from [cspell-dicts](https://github.com/streetsidesoftware/cspell-dicts) (MIT): software terms, git, docker, node, typescript, python, golang, shell, aws, companies |
| `dict/custom-words.txt` | Hand-maintained project/tool vocabulary                          |

Personal words are stored in `~/.pi/agent/pi-autocorrect.json` together with
the selected mode.

Refresh the tech dictionary with `npm run update-dicts`.

## Using it with pi

During development:

```bash
pi -e /path/to/pi-dev-autocorrect
```

Install permanently by linking it into your user extensions directory:

```bash
ln -s /path/to/pi-dev-autocorrect ~/.pi/agent/extensions/pi-dev-autocorrect
```

## Development

```bash
npm install        # typescript + pi type definitions
npm test           # 17 unit tests for the checking engine
npm run typecheck  # tsc --noEmit
```

The checking engine (`lib/`) is dependency-free TypeScript, so tests run with
Node's native type stripping — no build step.
