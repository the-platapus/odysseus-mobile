// Where this app's public repo lives. The Cookbook reads its README for the Recommended list,
// and model load failures are reported as issues there.
export const GITHUB_REPO = 'the-platapus/odysseus-mobile';
export const GITHUB_BRANCH = 'master';
export const README_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/README.md`;
/** Issue form in .github/ISSUE_TEMPLATE/ that load-failure reports open. */
export const LOAD_FAILURE_TEMPLATE = 'model-load-failure.yml';
