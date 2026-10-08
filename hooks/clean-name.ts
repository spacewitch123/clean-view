// The one cleaner every step name and job title passes through, so nothing
// technical (code, paths, file names) ever reaches the checklist.

export const MAX_NAME = 40
export const EMPTY_NAME = 'Working on it'

const CODE_FILE =
  /\b[\w.-]+\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|css|scss|sass|less|html?|json|ya?ml|toml|ini|md|mdx|sh|zsh|bash|sql|env|lock|vue|svelte|astro|prisma|graphql|gql|xml|csv|txt|log)\b/gi

export function cleanName(raw: unknown): string {
  let name = String(raw ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(CODE_FILE, ' ')
    .replace(/`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (name === '') {
    return EMPTY_NAME
  }

  name = name.charAt(0).toUpperCase() + name.slice(1)

  if (name.length > MAX_NAME) {
    const cut = name.slice(0, MAX_NAME - 1)
    const space = cut.lastIndexOf(' ')
    const head = space > 10 ? cut.slice(0, space) : cut
    name = `${head.replace(/[\s,.;:–-]+$/, '')}…`
  }

  return name
}
