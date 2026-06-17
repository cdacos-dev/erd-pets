<script>
  /**
   * @import { RecentProject } from './recentProjects.js'
   * @type {{
   *   projects: RecentProject[],
   *   highlightKey?: string | null,
   *   supported: boolean,
   *   onOpen: (project: RecentProject) => void,
   *   onRemove: (project: RecentProject) => void,
   *   onNew: () => void,
   *   onLoad: () => void
   * }}
   */
  let { projects, highlightKey = null, supported, onOpen, onRemove, onNew, onLoad } = $props();

  /**
   * Format an epoch timestamp as a short relative string.
   * @param {number} ts
   * @returns {string}
   */
  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }
</script>

<div class="welcome">
  <div class="panel">
    <h1>ERD Pets</h1>
    <p class="tagline">Open a diagram to get started.</p>

    <div class="primary-actions">
      <button class="primary" onclick={onNew}>New from SQL…</button>
      <button onclick={onLoad}>Open diagram…</button>
    </div>

    {#if supported}
      <section class="recents">
        <h2>Recent</h2>
        {#if projects.length === 0}
          <p class="empty">No recent projects yet. Diagrams you open are listed here.</p>
        {:else}
          <ul>
            {#each projects as project (project.key)}
              <li class:highlight={project.key === highlightKey}>
                <button class="recent-open" onclick={() => onOpen(project)} title={`Open ${project.name}`}>
                  <span class="name">{project.name}</span>
                  <span class="meta">{project.sqlFileName} · {relativeTime(project.lastOpened)}</span>
                </button>
                <button
                  class="recent-remove"
                  title="Remove from recents"
                  aria-label={`Remove ${project.name} from recents`}
                  onclick={() => onRemove(project)}
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {:else}
      <p class="empty">This browser can't store recent projects (IndexedDB unavailable).</p>
    {/if}
  </div>
</div>

<style>
  .welcome {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 5;
  }

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    box-shadow: var(--shadow-lg);
    padding: 28px 32px;
    width: 100%;
    max-width: 460px;
  }

  h1 {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 700;
    color: var(--color-text-heading);
  }

  .tagline {
    margin: 4px 0 20px;
    color: var(--color-text-secondary);
    font-size: var(--font-size-base);
  }

  .primary-actions {
    display: flex;
    gap: 10px;
    margin-bottom: 24px;
  }

  .primary-actions button {
    padding: 9px 16px;
    border-radius: 6px;
    font-size: var(--font-size-base);
    cursor: pointer;
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface);
    color: var(--color-text-primary);
  }

  .primary-actions button:hover {
    background: var(--color-surface-hover);
  }

  .primary-actions .primary {
    background: var(--color-accent);
    border-color: transparent;
    color: white;
  }

  .primary-actions .primary:hover {
    background: var(--color-accent-hover);
  }

  h2 {
    margin: 0 0 10px;
    font-size: var(--font-size-base);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  .empty {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm, 0.85rem);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 320px;
    overflow-y: auto;
  }

  li {
    display: flex;
    align-items: stretch;
    border-radius: 6px;
    overflow: hidden;
  }

  li.highlight {
    outline: 2px solid var(--color-accent);
  }

  .recent-open {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 8px 10px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-primary);
  }

  .recent-open:hover {
    background: var(--color-surface-hover);
  }

  .name {
    font-weight: 600;
    font-size: var(--font-size-base);
  }

  .meta {
    font-size: var(--font-size-sm, 0.8rem);
    color: var(--color-text-secondary);
  }

  .recent-remove {
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 12px;
  }

  .recent-remove:hover {
    background: var(--color-surface-hover);
    color: var(--color-text-primary);
  }
</style>
