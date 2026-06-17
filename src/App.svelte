<script>
  import { untrack, onMount } from 'svelte';
  import {
    SvelteFlow,
    Controls,
    MiniMap,
    MarkerType,
  } from '@xyflow/svelte';
  import { toCanvas } from 'html-to-image';
  import '@xyflow/svelte/dist/style.css';
  import TableNode from './lib/TableNode.svelte';
  import NoteNode from './lib/components/NoteNode.svelte';
  import TooltipEdge from './lib/TooltipEdge.svelte';
  import Toast from './lib/Toast.svelte';
  import DiagramToolbar from './lib/DiagramToolbar.svelte';
  import ConfirmDialog from './lib/ConfirmDialog.svelte';
  import AddDiagramDialog from './lib/AddDiagramDialog.svelte';
  import DiagramSettingsDialog from './lib/DiagramSettingsDialog.svelte';
  import CreateTableDialog from './lib/CreateTableDialog.svelte';
  import CreateRelationshipDialog from './lib/CreateRelationshipDialog.svelte';
  import Sidebar from './lib/sidebar/Sidebar.svelte';
  import ContextMenu from './lib/ContextMenu.svelte';
  import PaneContextMenu from './lib/PaneContextMenu.svelte';
  import ColumnContextMenu from './lib/ColumnContextMenu.svelte';
  import EdgeContextMenu from './lib/EdgeContextMenu.svelte';
  import NoteContextMenu from './lib/components/NoteContextMenu.svelte';
  import FlowInstanceCapture from './lib/FlowInstanceCapture.svelte';
  import RecentProjects from './lib/RecentProjects.svelte';
  import {
    isRecentSupported,
    listRecentProjects,
    saveRecentProject,
    removeRecentProject,
    hasReadPermission,
    ensureReadPermission,
    projectKey,
    getUrlProjectKey,
    setUrlProjectKey,
  } from './lib/recentProjects.js';
  import {
    isShareSupported,
    encodeShareLink,
    decodeShareLink,
    getUrlShareBlob,
    buildShareUrl,
    SHARE_SIZE_WARN,
  } from './lib/shareLink.js';
  import { circularLayout } from './lib/layouts/circular.js';
  import { hierarchicalLayout } from './lib/layouts/hierarchical.js';
  import {
    openDiagramFile,
    openSqlFile,
    refreshFiles,
    saveToFile,
    saveNewDiagramFile,
    isFileSystemAccessSupported,
  } from './lib/fileManager.js';
  import { parsePostgresSQL, generateForeignKeySql, removeForeignKeyStatement, addPrimaryKeyColumn, removePrimaryKeyColumn, findOrphanedAlterTables, removeOrphanedAlterTables } from './lib/parser/postgres.js';
  import {
    parseDiagramFile,
    resolveDiagramTables,
    serializeDiagramFile,
    createDefaultDiagramFile,
    resolveRelation,
    setTableVisibility,
    generateNoteId,
    updateNotePositions,
    generateArrowId,
    generateDiagramId,
  } from './lib/parser/diagram.js';

  const nodeTypes = {
    table: TableNode,
    note: NoteNode,
  };

  const edgeTypes = {
    tooltip: TooltipEdge,
  };

  /** @type {FileSystemFileHandle | null} */
  let diagramHandle = $state(null);

  /** @type {FileSystemFileHandle | null} */
  let sqlHandle = $state(null);

  /** @type {import('./lib/recentProjects.js').RecentProject[]} */
  let recentProjects = $state([]);

  /** Project key from the URL hash to highlight/auto-open on the welcome screen. */
  let pendingAutoOpenKey = $state(null);

  /** @type {string} */
  let diagramFileName = $state('');

  /** @type {string} */
  let sqlFileName = $state('');

  /** @type {string} */
  let diagramContent = $state('');

  /** @type {string} */
  let sqlContent = $state('');

  /** @type {import('./lib/Toast.svelte').Toast[]} */
  let toasts = $state([]);

  let toastId = 0;

  let nodes = $state.raw([]);
  let edges = $state.raw([]);

  /** @type {import('./lib/parser/types.js').DiagramFile | null} */
  let diagramFile = $state(null);

  /** @type {string} */
  let selectedDiagramId = $state('');

  /** @type {import('./lib/parser/types.js').ParseResult | null} */
  let parseResult = $state(null);

  /**
   * True when the current project was opened from a share link (`#d=`) and has
   * no file handles — a loaded, in-memory-only, read-only session.
   */
  let isSharedSession = $state(false);

  /**
   * Whether something is on screen (a diagram is loaded), regardless of whether
   * writable file handles exist. Distinct from `diagramHandle`/`sqlHandle`,
   * which gate disk writes (Save/Refresh/SQL edits).
   */
  let hasDiagram = $derived(!!diagramFile && !!parseResult);

  let diagrams = $derived(diagramFile?.diagrams ?? []);

  let dbType = $derived(diagramFile?.dbType ?? 'PostgreSQL');

  /** @type {import('./lib/parser/types.js').Note[]} */
  let currentNotes = $derived(
    diagramFile?.diagrams.find((d) => d.id === selectedDiagramId)?.notes ?? []
  );

  /** @type {import('./lib/parser/types.js').Arrow[]} */
  let currentArrows = $derived(
    diagramFile?.diagrams.find((d) => d.id === selectedDiagramId)?.arrows ?? []
  );

  /** @type {import('./lib/DiagramToolbar.svelte').LayoutType | null} */
  let pendingLayout = $state(null);

  let showLayoutConfirm = $state(false);
  let showRefreshConfirm = $state(false);
  let showCreateTableDialog = $state(false);
  let showCreateRelationshipDialog = $state(false);
  let showAddDiagramDialog = $state(false);
  let showDiagramSettingsDialog = $state(false);

  /** @type {string} */
  let editingTableName = $state('');

  /** @type {string} */
  let editingTableSql = $state('');

  /** @type {string} */
  let tableToDelete = $state('');

  let showDropTableConfirm = $state(false);

  let showIntegrityCheckConfirm = $state(false);

  /** @type {import('./lib/parser/types.js').OrphanedAlterTable[]} */
  let pendingOrphanedAlterTables = $state([]);

  /** @type {import('./lib/DiagramToolbar.svelte').EdgeStyle} */
  let edgeStyle = $state('rounded');

  let showSidebar = $state(false);

  /** @type {import('./lib/sidebar/Sidebar.svelte').SidebarMode} */
  let sidebarMode = $state('tables');

  /** Incremented to trigger focus on table search input */
  let focusTableSearch = $state(0);

  /** @type {boolean} */
  let isDarkMode = $state(false);

  // Load recent projects and, if the URL carries a project key, auto-open it when
  // file permission is still granted (otherwise highlight it for a one-click open).
  onMount(async () => {
    if (isRecentSupported()) {
      try {
        recentProjects = await listRecentProjects();
      } catch (err) {
        console.warn('Failed to load recent projects', err);
      }
    }

    // A share link (`#d=`) is an explicit, self-contained project; it wins over
    // the `#p=` recents key.
    const shareBlob = getUrlShareBlob();
    if (shareBlob) {
      await loadSharedProject(shareBlob);
      return;
    }

    const key = getUrlProjectKey();
    if (!key) return;

    const project = recentProjects.find((p) => p.key === key);
    if (!project) return;

    const granted =
      (await hasReadPermission(project.diagramHandle)) &&
      (await hasReadPermission(project.sqlHandle));

    if (granted) {
      try {
        await loadProject(project.diagramHandle, project.sqlHandle, { silent: true });
      } catch {
        pendingAutoOpenKey = key;
      }
    } else {
      // Permission needs a user gesture; surface the project for a single click.
      pendingAutoOpenKey = key;
    }
  });

  // Track dark mode changes
  $effect(() => {
    const updateDarkMode = () => {
      isDarkMode = document.documentElement.classList.contains('dark');
    };

    updateDarkMode();

    const observer = new MutationObserver(updateDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  });

  // Arrow marker color based on theme
  let markerColor = $derived(isDarkMode ? '#ffffff' : undefined);

  // Update edge markers when theme changes
  $effect(() => {
    const themeColor = markerColor; // This creates the dependency on markerColor
    // Read and write edges without tracking to avoid infinite loop
    untrack(() => {
      if (edges.length > 0) {
        edges = edges.map((edge) => ({
          ...edge,
          markerEnd: {
            ...edge.markerEnd,
            color: edge.data?.customMarkerColor ?? themeColor,
          },
        }));
      }
    });
  });

  /** @type {{ x: number, y: number, tableNames: string[] } | null} */
  let contextMenu = $state(null);

  /** @type {{ x: number, y: number } | null} */
  let paneContextMenu = $state(null);

  /** @type {{ x: number, y: number, tableName: string, columnName: string, isPrimaryKey: boolean } | null} */
  let columnContextMenu = $state(null);

  /** @type {{ x: number, y: number, noteId: string, color: string | undefined } | null} */
  let noteContextMenu = $state(null);

  /** @type {{ x: number, y: number, edgeId: string, sourceTable: string, sourceColumn: string, targetTable: string, targetColumn: string, isArrow: boolean } | null} */
  let edgeContextMenu = $state(null);

  /** @type {{ sourceTable: string, sourceColumn: string } | null} */
  let linkingState = $state(null);

  /** @type {{ sourceId: string, sourceType: 'table' | 'note' } | null} */
  let arrowLinkingState = $state(null);

  /** @type {string} */
  let prefilledSourceTable = $state('');
  /** @type {string} */
  let prefilledSourceColumn = $state('');
  /** @type {string} */
  let prefilledTargetTable = $state('');
  /** @type {string} */
  let prefilledTargetColumn = $state('');

  /** @type {string[]} */
  let selectedTableNames = $derived(
    nodes.filter((n) => n.selected).map((n) => n.id)
  );

  /** @type {Set<string>} */
  let visibleTableNames = $derived(new Set(nodes.map((n) => n.id)));

  /** @type {import('@xyflow/svelte').SvelteFlowInstance | null} */
  let flowInstance = $state(null);

  /**
   * Determine the best handles for connecting two nodes based on their positions.
   * Uses left/right edge of the specific column row, choosing optimal routing:
   * - Horizontally separated: opposite sides (right→left or left→right)
   * - Vertically aligned: same side (left→left or right→right)
   * @param {{x: number, y: number}} sourcePos
   * @param {{x: number, y: number}} targetPos
   * @param {string} sourceColumn
   * @param {string} targetColumn
   * @returns {{sourceHandle: string, targetHandle: string}}
   */
  function getBestHandles(sourcePos, targetPos, sourceColumn, targetColumn) {
    const dx = targetPos.x - sourcePos.x;
    const VERTICAL_THRESHOLD = 100; // Tables within this x-distance are "vertically aligned"

    if (Math.abs(dx) < VERTICAL_THRESHOLD) {
      // Tables are vertically aligned - use same side handles
      // Choose the side away from the slight horizontal offset
      if (dx >= 0) {
        // Target is slightly right, route edges out the left
        return {
          sourceHandle: `left-${sourceColumn}-source`,
          targetHandle: `left-${targetColumn}-target`,
        };
      } else {
        // Target is slightly left, route edges out the right
        return {
          sourceHandle: `right-${sourceColumn}-source`,
          targetHandle: `right-${targetColumn}-target`,
        };
      }
    }

    // Tables are horizontally separated - use opposite sides
    if (dx >= 0) {
      // Target is to the right of source
      return {
        sourceHandle: `right-${sourceColumn}-source`,
        targetHandle: `left-${targetColumn}-target`,
      };
    } else {
      // Target is to the left of source
      return {
        sourceHandle: `left-${sourceColumn}-source`,
        targetHandle: `right-${targetColumn}-target`,
      };
    }
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {import('./lib/Toast.svelte').ToastType} type
   */
  function showToast(message, type = 'info') {
    const id = ++toastId;
    toasts = [...toasts, { id, message, type }];

    // Errors persist until dismissed; others auto-dismiss
    if (type !== 'error') {
      setTimeout(() => {
        toasts = toasts.filter((t) => t.id !== id);
      }, 5000);
    }

    // Echo to console for debugging
    if (type === 'error') {
      console.error('[erd-pets]', message);
    }
  }

  /**
   * Dismiss a toast by id.
   * @param {number} id
   */
  function dismissToast(id) {
    toasts = toasts.filter((t) => t.id !== id);
  }

  /**
   * Guard for SQL-mutating actions: returns true when the SQL file is writable.
   * Otherwise toasts a context-appropriate message and returns false.
   * @returns {boolean}
   */
  function requireSqlHandle() {
    if (sqlHandle) return true;
    if (isSharedSession) {
      showToast('This is a shared diagram. Use "Save as files…" to edit it.', 'error');
    } else {
      showToast('No SQL file loaded. Open a diagram first.', 'error');
    }
    return false;
  }

  /**
   * Handle right-click on a single node.
   * @param {{ event: MouseEvent, node: { id: string, type?: string, data?: any } }} param
   */
  function handleNodeContextMenu({ event, node }) {
    event.preventDefault();
    closeContextMenu();

    // Check if this is a note node
    if (node.type === 'note') {
      noteContextMenu = {
        x: event.clientX,
        y: event.clientY,
        noteId: node.data?.id,
        color: node.data?.color,
      };
      return;
    }

    // Table node context menu
    const tableName = node.id;
    // If the clicked table is part of a selection, use all selected tables
    // Otherwise just use the clicked table
    const tableNames = selectedTableNames.includes(tableName)
      ? selectedTableNames
      : [tableName];
    contextMenu = { x: event.clientX, y: event.clientY, tableNames };
  }

  /**
   * Handle right-click on a selection of nodes.
   * @param {{ event: MouseEvent, nodes: Array<{ id: string }> }} param
   */
  function handleSelectionContextMenu({ event, nodes: selectedNodes }) {
    event.preventDefault();
    paneContextMenu = null; // Close pane context menu if open
    const tableNames = selectedNodes.map((n) => n.id);
    if (tableNames.length > 0) {
      contextMenu = { x: event.clientX, y: event.clientY, tableNames };
    }
  }

  /**
   * Handle right-click on the pane (canvas background).
   * @param {{ event: MouseEvent }} param
   */
  function handlePaneContextMenu({ event }) {
    event.preventDefault();
    contextMenu = null; // Close table context menu if open
    paneContextMenu = { x: event.clientX, y: event.clientY };
  }

  /**
   * Close all context menus.
   */
  function closeContextMenu() {
    contextMenu = null;
    paneContextMenu = null;
    columnContextMenu = null;
    noteContextMenu = null;
    edgeContextMenu = null;
  }

  /**
   * Handle right-click on a column.
   * @param {MouseEvent} event
   * @param {string} tableName
   * @param {string} columnName
   * @param {boolean} isPrimaryKey
   */
  function handleColumnContextMenu(event, tableName, columnName, isPrimaryKey) {
    contextMenu = null;
    paneContextMenu = null;
    columnContextMenu = { x: event.clientX, y: event.clientY, tableName, columnName, isPrimaryKey };
  }

  /**
   * Handle right-click on an edge (relationship or arrow).
   * @param {{ event: MouseEvent, edge: import('@xyflow/svelte').Edge }} param
   */
  function handleEdgeContextMenu({ event, edge }) {
    event.preventDefault();
    closeContextMenu();

    const isArrow = edge.data?.isArrow === true;
    const sourceTable = edge.source;
    const targetTable = edge.target;
    const sourceColumn = edge.data?.sourceColumn ?? '';
    const targetColumn = edge.data?.targetColumn ?? '';

    edgeContextMenu = {
      x: event.clientX,
      y: event.clientY,
      edgeId: edge.id,
      sourceTable,
      sourceColumn,
      targetTable,
      targetColumn,
      isArrow,
    };
  }

  /**
   * Handle delete from edge context menu.
   */
  function handleEdgeContextMenuDelete() {
    if (!edgeContextMenu) return;

    if (edgeContextMenu.isArrow) {
      // Find and delete the arrow
      const arrowId = edgeContextMenu.edgeId.replace('arrow-', '');
      const arrow = currentArrows.find((a) => a.id === arrowId);
      if (arrow) {
        handleDeleteArrow(arrow);
      }
    } else {
      // Find and delete the foreign key relationship
      const fk = parseResult?.foreignKeys.find(
        (f) =>
          f.sourceTable === edgeContextMenu.sourceTable &&
          f.sourceColumn === edgeContextMenu.sourceColumn &&
          f.targetTable === edgeContextMenu.targetTable &&
          f.targetColumn === edgeContextMenu.targetColumn
      );
      if (fk) {
        handleDeleteRelationship(fk);
      }
    }
  }

  /**
   * Start linking mode from a column.
   * @param {string} tableName
   * @param {string} columnName
   */
  function startLinking(tableName, columnName) {
    linkingState = { sourceTable: tableName, sourceColumn: columnName };
    columnContextMenu = null;
    // Update nodes to show linking UI
    updateNodesForLinking(true);
  }

  /**
   * Cancel linking mode.
   */
  function cancelLinking() {
    linkingState = null;
    updateNodesForLinking(false);
  }

  /**
   * Complete linking by clicking on target column.
   * @param {string} tableName
   * @param {string} columnName
   */
  function completeLinking(tableName, columnName) {
    if (!linkingState) return;

    // Pre-fill the dialog
    prefilledSourceTable = linkingState.sourceTable;
    prefilledSourceColumn = linkingState.sourceColumn;
    prefilledTargetTable = tableName;
    prefilledTargetColumn = columnName;

    // End linking mode
    linkingState = null;
    updateNodesForLinking(false);

    // Open the dialog
    showCreateRelationshipDialog = true;
  }

  /**
   * Update all nodes with linking state and callbacks.
   * @param {boolean} isLinking
   */
  function updateNodesForLinking(isLinking) {
    nodes = nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isLinking,
        onColumnContextMenu: handleColumnContextMenu,
        onColumnClick: isLinking ? completeLinking : undefined,
      },
    }));
  }

  // ============================================================================
  // Arrow linking (table-to-table)
  // ============================================================================

  /**
   * Start arrow linking mode from a table.
   * @param {string} tableName
   */
  function startArrowLinking(tableName) {
    arrowLinkingState = { sourceId: tableName, sourceType: 'table' };
    contextMenu = null;
    // Update nodes to show arrow linking UI
    updateNodesForArrowLinking(true);
  }

  /**
   * Start arrow linking mode from a note.
   * @param {string} noteId
   */
  function startArrowLinkingFromNote(noteId) {
    arrowLinkingState = { sourceId: noteId, sourceType: 'note' };
    noteContextMenu = null;
    // Update nodes to show arrow linking UI
    updateNodesForArrowLinking(true);
  }

  /**
   * Cancel arrow linking mode.
   */
  function cancelArrowLinking() {
    arrowLinkingState = null;
    updateNodesForArrowLinking(false);
  }

  /**
   * Complete arrow linking by clicking on a target (table or note).
   * @param {string} targetId
   */
  function completeArrowLinking(targetId) {
    if (!arrowLinkingState || !diagramFile || !selectedDiagramId) return;

    const sourceId = arrowLinkingState.sourceId;

    // Don't allow self-referential arrows
    if (sourceId === targetId) {
      showToast('Cannot create arrow to the same node.', 'error');
      arrowLinkingState = null;
      updateNodesForArrowLinking(false);
      return;
    }

    // Create the arrow
    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const existingArrows = diagram.arrows ?? [];

    /** @type {import('./lib/parser/types.js').Arrow} */
    const newArrow = {
      id: generateArrowId(existingArrows),
      from: sourceId,
      to: targetId,
    };

    // Update diagram file
    const updatedArrows = [...existingArrows, newArrow];
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, arrows: updatedArrows };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // End arrow linking mode
    arrowLinkingState = null;
    updateNodesForArrowLinking(false);

    // Re-render to show new edge
    if (parseResult) {
      const existingPositions = getNodePositions();
      convertToFlowWithDiagram(updatedDiagrams[diagramIndex], parseResult.tables, parseResult.foreignKeys, existingPositions);
    }

    showToast('Arrow created.', 'success');
  }

  /**
   * Update all nodes with arrow linking state and callbacks.
   * @param {boolean} isArrowLinking
   */
  function updateNodesForArrowLinking(isArrowLinking) {
    nodes = nodes.map((node) => {
      if (node.type === 'table') {
        return {
          ...node,
          data: {
            ...node.data,
            isArrowLinking,
            onTableClick: isArrowLinking ? completeArrowLinking : undefined,
          },
        };
      }
      if (node.type === 'note') {
        return {
          ...node,
          data: {
            ...node.data,
            isArrowLinking,
            onNodeClick: isArrowLinking ? completeArrowLinking : undefined,
          },
        };
      }
      return node;
    });
  }

  /**
   * Handle arrow creation from sidebar (opens a simple flow).
   */
  function handleCreateArrowFromSidebar() {
    showToast('Right-click a table or note and select "Create Arrow" to start.', 'info');
  }

  /**
   * Delete an arrow.
   * @param {import('./lib/parser/types.js').Arrow} arrow
   */
  function handleDeleteArrow(arrow) {
    if (!diagramFile || !selectedDiagramId) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const existingArrows = diagram.arrows ?? [];

    // Remove the arrow
    const updatedArrows = existingArrows.filter((a) => a.id !== arrow.id);
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, arrows: updatedArrows };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Re-render to remove edge
    if (parseResult) {
      const existingPositions = getNodePositions();
      convertToFlowWithDiagram(updatedDiagrams[diagramIndex], parseResult.tables, parseResult.foreignKeys, existingPositions);
    }

    showToast('Arrow deleted.', 'success');
  }

  /**
   * Get the current color for table(s) from the diagram file.
   * Returns the common color if all tables have the same color, undefined if mixed.
   * @param {string[]} tableNames
   * @returns {string | undefined}
   */
  function getTableColor(tableNames) {
    if (!diagramFile || !selectedDiagramId || tableNames.length === 0) return undefined;
    const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
    if (!diagram) return undefined;

    const colors = tableNames.map((name) => {
      const tableEntry = diagram.tables.find((t) => t.name === name);
      return tableEntry?.color;
    });

    // Return color only if all tables have the same color
    const firstColor = colors[0];
    return colors.every((c) => c === firstColor) ? firstColor : undefined;
  }

  /**
   * Handle color change for one or more tables.
   * @param {string[]} tableNames
   * @param {string | undefined} color
   */
  function handleTableColorChange(tableNames, color) {
    if (!diagramFile || !selectedDiagramId || !parseResult) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    let updatedTables = [...diagram.tables];

    for (const tableName of tableNames) {
      const tableIndex = updatedTables.findIndex((t) => t.name === tableName);

      if (tableIndex === -1) {
        // Table not in diagram (using wildcard), add explicit entry
        updatedTables.push({ name: tableName, color });
      } else {
        // Update existing entry
        if (color === undefined) {
          // Remove color property
          const { color: _, ...rest } = updatedTables[tableIndex];
          updatedTables[tableIndex] = rest;
        } else {
          updatedTables[tableIndex] = { ...updatedTables[tableIndex], color };
        }
      }
    }

    // Update diagram file
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, tables: updatedTables };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Preserve positions and re-render
    const existingPositions = getNodePositions();
    convertToFlowWithDiagram(
      updatedDiagrams[diagramIndex],
      parseResult.tables,
      parseResult.foreignKeys,
      existingPositions
    );
  }

  /**
   * Convert parsed tables and foreign keys to Svelte Flow nodes and edges.
   * Used when no @erd-pets block exists (shows all tables in grid layout).
   * @param {import('./lib/parser/types.js').Table[]} tables
   * @param {import('./lib/parser/types.js').ForeignKey[]} foreignKeys
   */
  function convertToFlow(tables, foreignKeys) {
    // Create a set of FK source columns for marking
    const fkColumns = new Set(
      foreignKeys.map((fk) => `${fk.sourceTable}.${fk.sourceColumn}`)
    );

    // Grid layout: 3 columns, spacing 300x250
    const cols = 3;
    const spacingX = 300;
    const spacingY = 250;

    // Build position map for handle calculation
    /** @type {Map<string, {x: number, y: number}>} */
    const positionMap = new Map();

    const newNodes = tables.map((table, index) => {
      const position = {
        x: (index % cols) * spacingX + 50,
        y: Math.floor(index / cols) * spacingY + 50,
      };
      positionMap.set(table.qualifiedName, position);
      return {
        id: table.qualifiedName,
        type: 'table',
        position,
        data: {
          label: table.qualifiedName,
          columns: table.columns.map((col) => ({
            name: col.name,
            type: col.type,
            isPrimaryKey: col.isPrimaryKey,
            isForeignKey: fkColumns.has(`${table.qualifiedName}.${col.name}`),
          })),
          isLinking: false,
          onColumnContextMenu: handleColumnContextMenu,
        },
      };
    });

    // Create edges only for FKs where both tables exist
    const tableNames = new Set(tables.map((t) => t.qualifiedName));
    const newEdges = foreignKeys
      .filter((fk) => tableNames.has(fk.sourceTable) && tableNames.has(fk.targetTable))
      .map((fk) => {
        const sourcePos = positionMap.get(fk.sourceTable);
        const targetPos = positionMap.get(fk.targetTable);
        const handles = getBestHandles(sourcePos, targetPos, fk.sourceColumn, fk.targetColumn);
        return {
          id: `${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}.${fk.targetColumn}`,
          source: fk.sourceTable,
          target: fk.targetTable,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: 'tooltip',
          markerEnd: { type: MarkerType.ArrowClosed, width: 50, height: 50, color: markerColor },
          data: { sourceColumn: fk.sourceColumn, targetColumn: fk.targetColumn, edgeStyle, customMarkerColor: undefined },
        };
      });

    nodes = newNodes;
    edges = newEdges;
  }

  /**
   * Convert using diagram positions from diagram file.
   * @param {import('./lib/parser/types.js').DiagramDefinition} diagram
   * @param {import('./lib/parser/types.js').Table[]} tables
   * @param {import('./lib/parser/types.js').ForeignKey[]} foreignKeys
   * @param {Map<string, {x: number, y: number}>} [existingPositions]
   */
  function convertToFlowWithDiagram(diagram, tables, foreignKeys, existingPositions) {
    const { resolved, errors } = resolveDiagramTables(diagram, tables, existingPositions);

    // Show resolution errors
    for (const error of errors) {
      showToast(error.message, 'error');
    }

    // Build set of tables in this diagram
    const diagramTables = new Set(resolved.map((r) => r.qualifiedName));

    // Create a set of FK source columns for marking
    const fkColumns = new Set(
      foreignKeys.map((fk) => `${fk.sourceTable}.${fk.sourceColumn}`)
    );

    // Build position map for handle calculation
    /** @type {Map<string, {x: number, y: number}>} */
    const positionMap = new Map(resolved.map((pos) => [pos.qualifiedName, { x: pos.x, y: pos.y }]));

    // Build nodes from resolved positions
    const tableMap = new Map(tables.map((t) => [t.qualifiedName, t]));
    const newNodes = resolved.map((pos) => {
      const table = tableMap.get(pos.qualifiedName);
      return {
        id: pos.qualifiedName,
        type: 'table',
        position: { x: pos.x, y: pos.y },
        data: {
          label: pos.qualifiedName,
          color: pos.color,
          columns: table?.columns.map((col) => ({
            name: col.name,
            type: col.type,
            isPrimaryKey: col.isPrimaryKey,
            isForeignKey: fkColumns.has(`${pos.qualifiedName}.${col.name}`),
          })) ?? [],
          isLinking: false,
          onColumnContextMenu: handleColumnContextMenu,
        },
      };
    });

    // Get relation rules for this diagram
    const relations = diagram.relations ?? [];

    // Create edges only for FKs where both tables are in diagram
    const newEdges = foreignKeys
      .filter((fk) => diagramTables.has(fk.sourceTable) && diagramTables.has(fk.targetTable))
      .map((fk) => {
        const resolved = resolveRelation(fk, relations);
        if (resolved.hidden) {
          return null;
        }
        const sourcePos = positionMap.get(fk.sourceTable);
        const targetPos = positionMap.get(fk.targetTable);
        const handles = getBestHandles(sourcePos, targetPos, fk.sourceColumn, fk.targetColumn);
        // Build style string for color and dashed
        const styleProps = [];
        if (resolved.color) styleProps.push(`stroke: ${resolved.color}`);
        if (resolved.line === 'dashed') styleProps.push('stroke-dasharray: 5 5');
        const style = styleProps.length > 0 ? styleProps.join('; ') : undefined;

        return {
          id: `${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}.${fk.targetColumn}`,
          source: fk.sourceTable,
          target: fk.targetTable,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: 'tooltip',
          style,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 50,
            height: 50,
            color: resolved.color ?? markerColor,
          },
          data: { sourceColumn: fk.sourceColumn, targetColumn: fk.targetColumn, edgeStyle, customMarkerColor: resolved.color },
        };
      })
      .filter((edge) => edge !== null);

    // Build note nodes from diagram notes
    const diagramNotes = diagram.notes ?? [];
    const noteNodes = diagramNotes.map((note) => {
      // Use existing position from canvas if available (for refresh scenarios)
      const existingNotePos = existingPositions?.get(note.id);
      const notePos = existingNotePos ?? { x: note.x, y: note.y };
      // Add note positions to positionMap for arrow edge calculation
      positionMap.set(note.id, notePos);
      return {
        id: note.id,
        type: 'note',
        position: notePos,
        data: {
          id: note.id,
          text: note.text,
          color: note.color,
          onTextChange: handleNoteTextChange,
        },
      };
    });

    // Build set of all valid node IDs (tables + notes) for arrow validation
    const diagramNoteIds = new Set(diagramNotes.map((n) => n.id));
    const allNodeIds = new Set([...diagramTables, ...diagramNoteIds]);

    // Build arrow edges from diagram arrows
    const diagramArrows = diagram.arrows ?? [];
    const arrowEdges = diagramArrows
      .filter((arrow) => allNodeIds.has(arrow.from) && allNodeIds.has(arrow.to))
      .map((arrow) => {
        const sourcePos = positionMap.get(arrow.from);
        const targetPos = positionMap.get(arrow.to);
        // Use center handles for arrows (not column-specific)
        const dx = (targetPos?.x ?? 0) - (sourcePos?.x ?? 0);
        const sourceHandle = dx >= 0 ? 'right-center-source' : 'left-center-source';
        const targetHandle = dx >= 0 ? 'left-center-target' : 'right-center-target';

        // Build style string for color
        const styleProps = [];
        if (arrow.color) styleProps.push(`stroke: ${arrow.color}`);
        const style = styleProps.length > 0 ? styleProps.join('; ') : undefined;

        return {
          id: `arrow-${arrow.id}`,
          source: arrow.from,
          target: arrow.to,
          sourceHandle,
          targetHandle,
          type: 'tooltip',
          style,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 50,
            height: 50,
            color: arrow.color ?? markerColor,
          },
          data: {
            sourceColumn: arrow.label ?? 'arrow',
            targetColumn: arrow.label ?? 'arrow',
            edgeStyle,
            customMarkerColor: arrow.color,
            isArrow: true,
          },
        };
      });

    nodes = [...newNodes, ...noteNodes];
    edges = [...newEdges, ...arrowEdges];
  }

  /**
   * Get current node positions as a Map.
   * @returns {Map<string, {x: number, y: number}>}
   */
  function getNodePositions() {
    return new Map(nodes.map((n) => [n.id, n.position]));
  }

  /**
   * Recalculate edge handles based on current node positions.
   */
  function recalculateEdgeHandles() {
    const positionMap = getNodePositions();
    edges = edges.map((edge) => {
      const sourcePos = positionMap.get(edge.source);
      const targetPos = positionMap.get(edge.target);
      if (!sourcePos || !targetPos || !edge.data?.sourceColumn || !edge.data?.targetColumn) {
        return edge;
      }
      const handles = getBestHandles(sourcePos, targetPos, edge.data.sourceColumn, edge.data.targetColumn);
      return {
        ...edge,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
      };
    });
  }

  /**
   * Handle diagram selection change.
   * @param {string} newDiagramId
   */
  function handleDiagramChange(newDiagramId) {
    if (!parseResult || !diagramFile) return;

    selectedDiagramId = newDiagramId;
    const diagram = diagramFile.diagrams.find((d) => d.id === newDiagramId);
    if (diagram) {
      convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys);
    }
  }

  /**
   * Handle add diagram button click.
   */
  function handleAddDiagram() {
    if (!diagramFile) {
      showToast('No diagram file loaded.', 'error');
      return;
    }
    showAddDiagramDialog = true;
  }

  /**
   * Handle add diagram form submission.
   * @param {string} title
   */
  function handleAddDiagramSubmit(title) {
    showAddDiagramDialog = false;

    if (!diagramFile || !parseResult) {
      showToast('No diagram file loaded.', 'error');
      return;
    }

    const id = generateDiagramId(title, diagramFile.diagrams);

    // If this is the first/only diagram, use wildcard; otherwise empty
    const isFirstDiagram = diagramFile.diagrams.length === 0;

    /** @type {import('./lib/parser/types.js').DiagramDefinition} */
    const newDiagram = {
      id,
      title,
      tables: isFirstDiagram ? [{ name: '*' }] : [],
    };

    // Add the new diagram to the file
    const updatedDiagrams = [...diagramFile.diagrams, newDiagram];
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Select the new diagram
    selectedDiagramId = id;
    convertToFlowWithDiagram(newDiagram, parseResult.tables, parseResult.foreignKeys);

    showToast(`Created diagram "${title}".`, 'success');
  }

  /**
   * Open diagram settings dialog.
   */
  function handleDiagramSettings() {
    if (!diagramFile || !selectedDiagramId) {
      showToast('No diagram selected.', 'error');
      return;
    }
    showDiagramSettingsDialog = true;
  }

  /**
   * Rename the current diagram.
   * @param {string} newTitle
   */
  function handleRenameDiagram(newTitle) {
    if (!diagramFile || !selectedDiagramId) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = {
      ...updatedDiagrams[diagramIndex],
      title: newTitle,
    };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    showToast('Diagram renamed.', 'success');
  }

  /**
   * Delete the current diagram.
   */
  function handleDeleteDiagram() {
    if (!diagramFile || !selectedDiagramId || !parseResult) return;

    if (diagramFile.diagrams.length <= 1) {
      showToast('Cannot delete the only diagram.', 'error');
      return;
    }

    const updatedDiagrams = diagramFile.diagrams.filter((d) => d.id !== selectedDiagramId);
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Select first remaining diagram
    selectedDiagramId = updatedDiagrams[0].id;
    const diagram = updatedDiagrams[0];
    convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys);

    showDiagramSettingsDialog = false;
    showToast('Diagram deleted.', 'success');
  }

  /**
   * Update diagram table entries.
   * @param {import('./lib/parser/types.js').DiagramTableEntry[]} entries
   */
  function handleUpdateDiagramEntries(entries) {
    if (!diagramFile || !selectedDiagramId || !parseResult) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = {
      ...updatedDiagrams[diagramIndex],
      tables: entries,
    };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Re-render diagram with preserved positions
    const existingPositions = getNodePositions();
    convertToFlowWithDiagram(
      updatedDiagrams[diagramIndex],
      parseResult.tables,
      parseResult.foreignKeys,
      existingPositions
    );
  }

  /**
   * Read a diagram + SQL handle pair, parse, render, and record as a recent project.
   * @param {FileSystemFileHandle} dHandle - Diagram (.erd-pets.json) handle
   * @param {FileSystemFileHandle} sHandle - SQL file handle
   * @param {{ silent?: boolean }} [options]
   * @returns {Promise<boolean>} Whether the project loaded successfully
   */
  async function loadProject(dHandle, sHandle, options = {}) {
    const dFile = await dHandle.getFile();
    const dContent = await dFile.text();

    const { data: parsedDiagram, errors: diagramErrors } = parseDiagramFile(dContent);
    if (diagramErrors.length > 0) {
      for (const error of diagramErrors) {
        showToast(error.message, 'error');
      }
    }
    if (!parsedDiagram) {
      showToast('Failed to parse diagram file.', 'error');
      return false;
    }

    const sFile = await sHandle.getFile();
    const sContent = await sFile.text();
    const newParseResult = parsePostgresSQL(sContent);
    if (newParseResult.errors.length > 0) {
      for (const error of newParseResult.errors) {
        showToast(error.message || String(error), 'error');
      }
    }

    diagramHandle = dHandle;
    sqlHandle = sHandle;
    diagramFileName = dFile.name;
    sqlFileName = sFile.name;
    diagramContent = dContent;
    sqlContent = sContent;
    diagramFile = parsedDiagram;
    parseResult = newParseResult;
    isSharedSession = false;

    selectedDiagramId = parsedDiagram.diagrams[0]?.id ?? '';
    if (selectedDiagramId) {
      const diagram = parsedDiagram.diagrams.find((d) => d.id === selectedDiagramId);
      if (diagram) {
        convertToFlowWithDiagram(diagram, newParseResult.tables, newParseResult.foreignKeys);
      }
    } else {
      convertToFlow(newParseResult.tables, newParseResult.foreignKeys);
    }

    await rememberProject(dHandle, sHandle, dFile.name, sFile.name);

    if (newParseResult.tables.length === 0) {
      showToast('No tables found in the SQL file.', 'info');
    } else if (!options.silent) {
      showToast(`Loaded ${newParseResult.tables.length} tables.`, 'success');
    }
    return true;
  }

  /**
   * Record a loaded project in recents and update the bookmarkable URL hash.
   * @param {FileSystemFileHandle} dHandle
   * @param {FileSystemFileHandle} sHandle
   * @param {string} dName - Diagram file name
   * @param {string} sName - SQL file name
   */
  async function rememberProject(dHandle, sHandle, dName, sName) {
    const key = projectKey(dName);
    setUrlProjectKey(key);
    pendingAutoOpenKey = null;
    if (!isRecentSupported()) return;
    try {
      await saveRecentProject({
        key,
        name: dName.replace(/\.erd-pets\.json$/i, '').replace(/\.json$/i, ''),
        diagramFileName: dName,
        sqlFileName: sName,
        diagramHandle: dHandle,
        sqlHandle: sHandle,
      });
      recentProjects = await listRecentProjects();
    } catch (err) {
      // Persisting recents is best-effort; never block the load on it.
      console.warn('Failed to save recent project', err);
    }
  }

  /**
   * Load a project from a self-contained share link blob (`#d=`).
   * There are no file handles — the session is read-only until the recipient
   * uses "Save as files…".
   * @param {string} blob
   */
  async function loadSharedProject(blob) {
    let sql, diagram;
    try {
      ({ sql, diagram } = await decodeShareLink(blob));
    } catch (err) {
      showToast('This share link is invalid or corrupted.', 'error');
      return;
    }

    const { data: parsedDiagram, errors: diagramErrors } = parseDiagramFile(diagram);
    if (diagramErrors.length > 0) {
      for (const error of diagramErrors) {
        showToast(error.message, 'error');
      }
    }
    if (!parsedDiagram) {
      showToast('This share link is invalid or corrupted.', 'error');
      return;
    }

    const newParseResult = parsePostgresSQL(sql);
    if (newParseResult.errors.length > 0) {
      for (const error of newParseResult.errors) {
        showToast(error.message || String(error), 'error');
      }
    }

    // No files: leave handles null and flag the read-only shared session.
    diagramHandle = null;
    sqlHandle = null;
    diagramFileName = parsedDiagram.sql || 'shared-diagram';
    sqlFileName = parsedDiagram.sql || '';
    diagramContent = diagram;
    sqlContent = sql;
    diagramFile = parsedDiagram;
    parseResult = newParseResult;
    isSharedSession = true;

    selectedDiagramId = parsedDiagram.diagrams[0]?.id ?? '';
    if (selectedDiagramId) {
      const d = parsedDiagram.diagrams.find((x) => x.id === selectedDiagramId);
      if (d) {
        convertToFlowWithDiagram(d, newParseResult.tables, newParseResult.foreignKeys);
      }
    } else {
      convertToFlow(newParseResult.tables, newParseResult.foreignKeys);
    }

    if (newParseResult.tables.length === 0) {
      showToast('No tables found in the shared diagram.', 'info');
    } else {
      showToast(`Opened shared diagram (${newParseResult.tables.length} tables).`, 'success');
    }
  }

  /**
   * Build a serialized diagram string capturing the current on-screen layout
   * (table positions + note positions), matching what a save would persist.
   * @returns {string}
   */
  function serializeCurrentLayout() {
    const nodePositions = getNodePositions();
    const notePositions = getNotePositions();
    let fileToSerialize = diagramFile;

    const diagramIndex = fileToSerialize.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex !== -1) {
      const diagram = fileToSerialize.diagrams[diagramIndex];
      if (diagram.notes && diagram.notes.length > 0) {
        const updatedNotes = updateNotePositions(diagram.notes, notePositions);
        const updatedDiagrams = [...fileToSerialize.diagrams];
        updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
        fileToSerialize = { ...fileToSerialize, diagrams: updatedDiagrams };
      }
    }

    return serializeDiagramFile(
      fileToSerialize,
      selectedDiagramId,
      nodePositions,
      parseResult?.tables ?? []
    );
  }

  /**
   * Generate a self-contained share link for the current project and copy it to
   * the clipboard. Everything (SQL + layout) is encoded into the URL fragment.
   */
  async function handleShare() {
    if (!hasDiagram) {
      showToast('Open a diagram first.', 'error');
      return;
    }
    if (!isShareSupported()) {
      showToast('Share links are not supported in this browser.', 'error');
      return;
    }

    try {
      const diagramString = serializeCurrentLayout();
      const blob = await encodeShareLink({ sql: sqlContent, diagram: diagramString });
      const url = buildShareUrl(blob);

      try {
        await navigator.clipboard.writeText(url);
        showToast(`Share link copied (${url.length} chars).`, 'success');
      } catch {
        // Clipboard can be blocked (permissions / no user activation): surface
        // the URL so the user can copy it manually.
        showToast(`Copy this share link manually:\n${url}`, 'info');
      }

      if (url.length > SHARE_SIZE_WARN) {
        showToast(
          `This link is large (${url.length} chars); some chat apps may truncate it.`,
          'error'
        );
      }
    } catch (err) {
      showToast(err.message || 'Failed to create share link.', 'error');
    }
  }

  /**
   * Convert a read-only shared session into a real local project by writing the
   * SQL and diagram to files the user picks. After this, Save/Refresh/edit work.
   */
  async function handleSaveAsFiles() {
    if (!isFileSystemAccessSupported()) {
      showToast(
        'File System Access API not supported. Please use Chrome, Edge, or another Chromium-based browser.',
        'error'
      );
      return;
    }
    if (!diagramFile || !parseResult) {
      showToast('No diagram to save.', 'error');
      return;
    }

    try {
      // Step 1: Save the SQL to a file chosen by the user.
      const suggestedSqlName = sqlFileName || diagramFile.sql || 'schema.sql';
      const newSqlHandle = await window.showSaveFilePicker({
        suggestedName: suggestedSqlName,
        types: [{ description: 'SQL Files', accept: { 'text/plain': ['.sql'] } }],
      });
      const sqlWritable = await newSqlHandle.createWritable();
      try {
        await sqlWritable.write(sqlContent);
      } finally {
        await sqlWritable.close();
      }
      const savedSqlFile = await newSqlHandle.getFile();

      // Step 2: Point the diagram's `sql` reference at the chosen SQL file and
      // serialize the current layout, then save the diagram file.
      const diagramToSave = { ...diagramFile, sql: savedSqlFile.name };
      const nodePositions = getNodePositions();
      const serialized = serializeDiagramFile(
        diagramToSave,
        selectedDiagramId,
        nodePositions,
        parseResult.tables
      );
      const newDiagramHandle = await saveNewDiagramFile(serialized, newSqlHandle);
      const savedDiagramFile = await newDiagramHandle.getFile();

      // Step 3: Promote to a real, writable local project.
      diagramHandle = newDiagramHandle;
      sqlHandle = newSqlHandle;
      diagramFileName = savedDiagramFile.name;
      sqlFileName = savedSqlFile.name;
      diagramContent = serialized;
      diagramFile = diagramToSave;
      isSharedSession = false;

      // Step 4: Record as a recent project + bookmarkable URL (replaces `#d=`).
      await rememberProject(newDiagramHandle, newSqlHandle, savedDiagramFile.name, savedSqlFile.name);

      showToast('Saved as local files. You can now edit and save changes.', 'success');
    } catch (err) {
      if (err.name === 'AbortError') {
        return;
      }
      showToast(err.message || 'Failed to save as files.', 'error');
    }
  }

  /**
   * Open a project from the recents list, re-requesting file permission as needed.
   * @param {import('./lib/recentProjects.js').RecentProject} project
   */
  async function openRecent(project) {
    try {
      const grantedDiagram = await ensureReadPermission(project.diagramHandle);
      const grantedSql = await ensureReadPermission(project.sqlHandle);
      if (!grantedDiagram || !grantedSql) {
        showToast('Permission to read the project files was not granted.', 'error');
        return;
      }
      await loadProject(project.diagramHandle, project.sqlHandle);
    } catch (err) {
      if (err.name === 'NotFoundError') {
        showToast(`"${project.name}" could not be found — it may have been moved or deleted.`, 'error');
        await removeRecent(project);
        return;
      }
      showToast(err.message || 'Failed to open recent project.', 'error');
    }
  }

  /**
   * Remove a project from the recents list.
   * @param {import('./lib/recentProjects.js').RecentProject} project
   */
  async function removeRecent(project) {
    try {
      await removeRecentProject(project.key);
      recentProjects = await listRecentProjects();
      if (pendingAutoOpenKey === project.key) {
        pendingAutoOpenKey = null;
      }
    } catch (err) {
      showToast(err.message || 'Failed to remove recent project.', 'error');
    }
  }

  /**
   * Handle New Diagram button click.
   */
  async function handleNew() {
    if (!isFileSystemAccessSupported()) {
      showToast(
        'File System Access API not supported. Please use Chrome, Edge, or another Chromium-based browser.',
        'error'
      );
      return;
    }

    try {
      // Step 1: Open SQL file
      const sqlResult = await openSqlFile();
      const newSqlHandle = sqlResult.handle;
      const newSqlContent = sqlResult.content;

      // Step 2: Parse SQL to validate it
      const newParseResult = parsePostgresSQL(newSqlContent);

      if (newParseResult.errors.length > 0) {
        for (const error of newParseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      if (newParseResult.tables.length === 0) {
        showToast('No tables found in the SQL file.', 'error');
        return;
      }

      // Step 3: Create default diagram file content
      const sqlFile = await newSqlHandle.getFile();
      const defaultDiagram = createDefaultDiagramFile(sqlFile.name);
      const diagramContent = JSON.stringify(defaultDiagram, null, 2);

      // Step 4: Save new diagram file (picker starts in same directory as SQL file)
      const newDiagramHandle = await saveNewDiagramFile(diagramContent, newSqlHandle);

      // Step 5: Update state
      diagramHandle = newDiagramHandle;
      sqlHandle = newSqlHandle;
      diagramFileName = newDiagramHandle.name;
      sqlFileName = sqlFile.name;
      sqlContent = newSqlContent;
      parseResult = newParseResult;
      diagramFile = defaultDiagram;
      isSharedSession = false;
      selectedDiagramId = 'main';

      // Step 6: Render diagram
      const diagram = diagramFile.diagrams[0];
      convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys);

      // Step 7: Record as a recent project and update the bookmarkable URL
      await rememberProject(newDiagramHandle, newSqlHandle, newDiagramHandle.name, sqlFile.name);

      showToast(`Created new diagram with ${parseResult.tables.length} tables.`, 'success');
    } catch (err) {
      // User cancelled the picker - not an error
      if (err.name === 'AbortError') {
        return;
      }
      showToast(err.message || 'Failed to create diagram.', 'error');
    }
  }

  /**
   * Handle Load Diagram button click.
   */
  async function handleLoad() {
    if (!isFileSystemAccessSupported()) {
      showToast(
        'File System Access API not supported. Please use Chrome, Edge, or another Chromium-based browser.',
        'error'
      );
      return;
    }

    try {
      // Step 1: Open diagram file
      const diagramResult = await openDiagramFile();

      // Step 2: Peek at the diagram so we can tell the user which SQL file to pick
      const { data: parsedDiagram } = parseDiagramFile(diagramResult.content);
      if (parsedDiagram?.sql) {
        showToast(`Please select: ${parsedDiagram.sql}`, 'info');
      }

      // Step 3: Open the SQL file (picker starts in same directory as diagram)
      const sqlResult = await openSqlFile(diagramResult.handle);

      // Step 4: Parse, render, and record (shared with recents/auto-open)
      await loadProject(diagramResult.handle, sqlResult.handle);
    } catch (err) {
      // User cancelled the picker - not an error
      if (err.name === 'AbortError') {
        return;
      }
      showToast(err.message || 'Failed to load file.', 'error');
    }
  }

  /**
   * Handle Save button click.
   * Checks for orphaned ALTER TABLE statements before saving.
   */
  async function handleSave() {
    if (!diagramHandle || !diagramFile) {
      showToast('No file loaded. Use Load Diagram first.', 'error');
      return;
    }

    // Check for orphaned ALTER TABLE statements
    if (sqlContent) {
      const orphaned = findOrphanedAlterTables(sqlContent);
      if (orphaned.length > 0) {
        pendingOrphanedAlterTables = orphaned;
        showIntegrityCheckConfirm = true;
        return;
      }
    }

    await performSave();
  }

  /**
   * Perform the actual save operation.
   */
  async function performSave() {
    try {
      // Collect positions from nodes
      const nodePositions = getNodePositions();

      // Update note positions in the diagram file
      const notePositions = getNotePositions();
      const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
      if (diagramIndex !== -1) {
        const diagram = diagramFile.diagrams[diagramIndex];
        if (diagram.notes && diagram.notes.length > 0) {
          const updatedNotes = updateNotePositions(diagram.notes, notePositions);
          const updatedDiagrams = [...diagramFile.diagrams];
          updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
          diagramFile = { ...diagramFile, diagrams: updatedDiagrams };
        }
      }

      // Serialize diagram file with updated positions
      const newContent = serializeDiagramFile(
        diagramFile,
        selectedDiagramId,
        nodePositions,
        parseResult?.tables ?? []
      );

      // Save to diagram file (SQL file is not modified)
      await saveToFile(diagramHandle, newContent);
      diagramContent = newContent;

      // Re-parse to update state
      const { data } = parseDiagramFile(newContent);
      if (data) {
        diagramFile = data;
      }

      showToast('Diagram saved.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save file.', 'error');
    }
  }

  /**
   * Apply integrity fix: remove orphaned ALTER TABLE statements and save.
   */
  async function applyIntegrityFix() {
    showIntegrityCheckConfirm = false;

    if (pendingOrphanedAlterTables.length > 0 && sqlHandle) {
      try {
        const newSqlContent = removeOrphanedAlterTables(sqlContent, pendingOrphanedAlterTables);
        await saveToFile(sqlHandle, newSqlContent);
        sqlContent = newSqlContent;

        // Re-parse SQL to update state
        parseResult = parsePostgresSQL(newSqlContent);

        showToast(`Removed ${pendingOrphanedAlterTables.length} orphaned ALTER TABLE statement(s).`, 'info');
      } catch (err) {
        showToast(err.message || 'Failed to fix SQL file.', 'error');
      }
    }

    pendingOrphanedAlterTables = [];
    await performSave();
  }

  /**
   * Skip integrity fix and proceed with save.
   */
  async function skipIntegrityFix() {
    showIntegrityCheckConfirm = false;
    pendingOrphanedAlterTables = [];
    await performSave();
  }

  /**
   * Handle Refresh button click.
   * Shows confirmation dialog before reloading.
   */
  function handleRefresh() {
    if (!diagramHandle || !sqlHandle) {
      showToast('No file loaded. Use Load Diagram first.', 'error');
      return;
    }
    showRefreshConfirm = true;
  }

  /**
   * Apply refresh after user confirmation.
   */
  async function applyRefresh() {
    showRefreshConfirm = false;

    try {
      const previousDiagramId = selectedDiagramId;

      // Refresh both files
      const refreshed = await refreshFiles(diagramHandle, sqlHandle);
      diagramContent = refreshed.diagramContent;
      sqlContent = refreshed.sqlContent;

      // Re-parse diagram file
      const { data: parsedDiagram, errors: diagramErrors } = parseDiagramFile(diagramContent);

      if (diagramErrors.length > 0) {
        for (const error of diagramErrors) {
          showToast(error.message, 'error');
        }
      }

      if (!parsedDiagram) {
        showToast('Failed to parse diagram file.', 'error');
        return;
      }

      diagramFile = parsedDiagram;

      // Re-parse SQL
      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      // Try to preserve selected diagram, or fall back to first
      const diagramExists = diagramFile.diagrams.some((d) => d.id === previousDiagramId);
      selectedDiagramId = diagramExists
        ? previousDiagramId
        : (diagramFile.diagrams[0]?.id ?? '');

      if (selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          convertToFlowWithDiagram(
            diagram,
            parseResult.tables,
            parseResult.foreignKeys
          );
        }
      } else {
        convertToFlow(parseResult.tables, parseResult.foreignKeys);
      }

      showToast('Diagram reloaded.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to refresh files.', 'error');
    }
  }

  /**
   * Cancel refresh confirmation.
   */
  function cancelRefresh() {
    showRefreshConfirm = false;
  }

  /**
   * Open the create table dialog (for new table).
   */
  function handleCreateTable() {
    if (!requireSqlHandle()) return;
    editingTableName = '';
    editingTableSql = '';
    showCreateTableDialog = true;
  }

  /**
   * Handle CREATE TABLE dialog submission.
   * Either inserts a new table or replaces an existing one.
   * @param {string} newTableSql
   */
  async function handleCreateTableSubmit(newTableSql) {
    showCreateTableDialog = false;

    if (!requireSqlHandle()) return;

    const isEditing = !!editingTableName;

    try {
      let newSqlContent;
      let tableToCenter = '';

      if (isEditing) {
        // Edit mode: replace existing CREATE TABLE statement
        const extracted = extractTableDdl(editingTableName);
        if (!extracted) {
          showToast(`Could not find CREATE TABLE for "${editingTableName}".`, 'error');
          return;
        }

        const before = sqlContent.slice(0, extracted.start);
        const after = sqlContent.slice(extracted.end);
        newSqlContent = before + newTableSql + after;
        tableToCenter = editingTableName;
      } else {
        // Create mode: insert after last CREATE TABLE, before first ALTER TABLE
        const existingTableNames = new Set(parseResult?.tables.map((t) => t.qualifiedName) ?? []);

        const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."]+\s*\([^)]*(?:\([^)]*\)[^)]*)*\)\s*;/gi;
        const alterTableRegex = /ALTER\s+TABLE\s+/i;

        let lastCreateTableEnd = 0;
        let match;

        while ((match = createTableRegex.exec(sqlContent)) !== null) {
          lastCreateTableEnd = match.index + match[0].length;
        }

        const alterMatch = alterTableRegex.exec(sqlContent);
        const firstAlterStart = alterMatch ? alterMatch.index : sqlContent.length;

        let insertionPoint;
        if (lastCreateTableEnd > 0) {
          insertionPoint = lastCreateTableEnd;
        } else if (alterMatch) {
          insertionPoint = firstAlterStart;
        } else {
          insertionPoint = sqlContent.length;
        }

        const before = sqlContent.slice(0, insertionPoint);
        const after = sqlContent.slice(insertionPoint);
        newSqlContent = before + '\n\n' + newTableSql + '\n' + after;

        // We'll find the new table after parsing
        parseResult = parsePostgresSQL(newSqlContent);
        const newTable = parseResult.tables.find((t) => !existingTableNames.has(t.qualifiedName));
        if (newTable) {
          tableToCenter = newTable.qualifiedName;
        }
      }

      // Save to SQL file
      await saveToFile(sqlHandle, newSqlContent);
      sqlContent = newSqlContent;

      // Re-parse and refresh diagram
      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      // Re-render current diagram with preserved positions
      if (diagramFile && selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          const existingPositions = getNodePositions();
          convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys, existingPositions);
        }
      }

      showToast(isEditing ? 'Table updated.' : 'Table created.', 'success');

      // Center on the table after rendering
      if (tableToCenter && flowInstance) {
        requestAnimationFrame(() => {
          handleCenterTable(tableToCenter);
        });
      }

      // Clear editing state
      editingTableName = '';
      editingTableSql = '';
    } catch (err) {
      showToast(err.message || 'Failed to save table.', 'error');
    }
  }

  /**
   * Open the create relationship dialog.
   */
  function handleCreateRelationship() {
    if (!requireSqlHandle()) return;
    if (!parseResult || parseResult.tables.length === 0) {
      showToast('No tables found. Create tables first.', 'error');
      return;
    }
    showCreateRelationshipDialog = true;
  }

  /**
   * Handle CREATE RELATIONSHIP dialog submission.
   * @param {string} sourceTable
   * @param {string} sourceColumn
   * @param {string} targetTable
   * @param {string} targetColumn
   */
  async function handleCreateRelationshipSubmit(sourceTable, sourceColumn, targetTable, targetColumn) {
    showCreateRelationshipDialog = false;
    prefilledSourceTable = '';
    prefilledSourceColumn = '';
    prefilledTargetTable = '';
    prefilledTargetColumn = '';

    if (!requireSqlHandle()) return;

    try {
      const fkSql = generateForeignKeySql(sourceTable, sourceColumn, targetTable, targetColumn);
      const newSqlContent = sqlContent.trimEnd() + '\n\n' + fkSql + '\n';

      await saveToFile(sqlHandle, newSqlContent);
      sqlContent = newSqlContent;

      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      if (diagramFile && selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          const existingPositions = getNodePositions();
          convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys, existingPositions);
        }
      }

      showToast('Relationship created.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to create relationship.', 'error');
    }
  }

  /**
   * Delete a foreign key relationship.
   * @param {import('./lib/parser/types.js').ForeignKey} fk
   */
  async function handleDeleteRelationship(fk) {
    if (!requireSqlHandle()) return;

    try {
      const result = removeForeignKeyStatement(sqlContent, fk);

      if ('error' in result) {
        showToast(result.error, 'error');
        return;
      }

      await saveToFile(sqlHandle, result.sql);
      sqlContent = result.sql;

      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      if (diagramFile && selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          const existingPositions = getNodePositions();
          convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys, existingPositions);
        }
      }

      showToast('Relationship deleted.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete relationship.', 'error');
    }
  }

  /**
   * Toggle primary key status for a column.
   * @param {string} tableName - Qualified table name (schema.table)
   * @param {string} columnName
   * @param {boolean} currentlyPrimaryKey
   */
  async function handleTogglePrimaryKey(tableName, columnName, currentlyPrimaryKey) {
    if (!requireSqlHandle()) return;

    try {
      const result = currentlyPrimaryKey
        ? removePrimaryKeyColumn(sqlContent, tableName, columnName)
        : addPrimaryKeyColumn(sqlContent, tableName, columnName);

      if ('error' in result) {
        showToast(result.error, 'error');
        return;
      }

      await saveToFile(sqlHandle, result.sql);
      sqlContent = result.sql;

      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      if (diagramFile && selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          const existingPositions = getNodePositions();
          convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys, existingPositions);
        }
      }

      showToast(
        currentlyPrimaryKey ? 'Removed from primary key.' : 'Added to primary key.',
        'success'
      );
    } catch (err) {
      showToast(err.message || 'Failed to update primary key.', 'error');
    }
  }

  /**
   * Handle layout button click from toolbar.
   * Shows confirmation dialog before applying.
   * @param {import('./lib/DiagramToolbar.svelte').LayoutType} layoutType
   */
  function handleLayoutRequest(layoutType) {
    if (nodes.length === 0) {
      showToast('No tables to layout.', 'error');
      return;
    }
    pendingLayout = layoutType;
    showLayoutConfirm = true;
  }

  /**
   * Apply the pending layout after user confirmation.
   */
  function applyLayout() {
    if (!pendingLayout) return;

    /** @type {Map<string, {x: number, y: number}>} */
    let newPositions;

    switch (pendingLayout) {
      case 'circular':
        newPositions = circularLayout(nodes);
        break;
      case 'hierarchical':
        newPositions = hierarchicalLayout(nodes, edges);
        break;
      default:
        showToast(`Unknown layout: ${pendingLayout}`, 'error');
        showLayoutConfirm = false;
        pendingLayout = null;
        return;
    }

    // Apply new positions to nodes
    nodes = nodes.map((node) => {
      const newPos = newPositions.get(node.id);
      if (newPos) {
        return { ...node, position: newPos };
      }
      return node;
    });

    // Recalculate edge handles for new positions
    recalculateEdgeHandles();

    showToast(`Applied ${pendingLayout} layout.`, 'success');
    showLayoutConfirm = false;
    pendingLayout = null;
  }

  /**
   * Cancel layout confirmation.
   */
  function cancelLayout() {
    showLayoutConfirm = false;
    pendingLayout = null;
  }

  /**
   * Handle edge style change.
   * @param {import('./lib/DiagramToolbar.svelte').EdgeStyle} newStyle
   */
  function handleEdgeStyleChange(newStyle) {
    edgeStyle = newStyle;
    // Update all existing edges with new style
    edges = edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, edgeStyle: newStyle },
    }));
  }

  /**
   * Handle table visibility toggle from the side panel.
   * @param {string} qualifiedName
   * @param {boolean} visible
   */
  function handleTableVisibilityToggle(qualifiedName, visible) {
    if (!diagramFile || !selectedDiagramId || !parseResult) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const updatedTables = setTableVisibility(diagram.tables, qualifiedName, visible);

    // Update diagram file with new tables array
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, tables: updatedTables };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Preserve current positions and re-render
    const existingPositions = getNodePositions();
    convertToFlowWithDiagram(
      updatedDiagrams[diagramIndex],
      parseResult.tables,
      parseResult.foreignKeys,
      existingPositions
    );
  }

  /**
   * Extract a CREATE TABLE statement from SQL content for a specific table.
   * @param {string} qualifiedName - e.g. "public.users"
   * @returns {{ sql: string, start: number, end: number } | null}
   */
  function extractTableDdl(qualifiedName) {
    const [schema, tableName] = qualifiedName.split('.');

    // Build pattern to match CREATE TABLE with this name
    // Handles: schema.name, "schema"."name", schema."name", etc.
    const schemaPattern = schema === 'public'
      ? `(?:public\\.|"public"\\.|)`
      : `(?:${schema}\\.|"${schema}"\\.)`;
    const namePattern = `(?:${tableName}|"${tableName}")`;
    const pattern = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${schemaPattern}${namePattern}\\s*\\(`,
      'gi'
    );

    const match = pattern.exec(sqlContent);
    if (!match) return null;

    const start = match.index;
    let pos = match.index + match[0].length;
    let depth = 1;

    // Find matching closing paren
    while (pos < sqlContent.length && depth > 0) {
      if (sqlContent[pos] === '(') depth++;
      else if (sqlContent[pos] === ')') depth--;
      pos++;
    }

    // Skip to semicolon
    while (pos < sqlContent.length && sqlContent[pos] !== ';') {
      pos++;
    }
    if (sqlContent[pos] === ';') pos++;

    return {
      sql: sqlContent.slice(start, pos).trim(),
      start,
      end: pos
    };
  }

  /**
   * Open DDL editor for a table.
   * @param {string} qualifiedName
   */
  function handleShowTableSql(qualifiedName) {
    if (!sqlContent) {
      showToast('No SQL file loaded.', 'error');
      return;
    }

    const extracted = extractTableDdl(qualifiedName);
    if (!extracted) {
      showToast(`Could not find CREATE TABLE for "${qualifiedName}".`, 'error');
      return;
    }

    editingTableName = qualifiedName;
    editingTableSql = extracted.sql;
    showCreateTableDialog = true;
  }

  /**
   * Request to drop a table (shows confirmation).
   * @param {string} qualifiedName
   */
  function handleDropTableRequest(qualifiedName) {
    if (!requireSqlHandle()) return;
    tableToDelete = qualifiedName;
    showDropTableConfirm = true;
  }

  /**
   * Find all ALTER TABLE statements that reference a given table.
   * Returns array of { start, end } positions to remove.
   * @param {string} qualifiedName
   * @returns {{ start: number, end: number }[]}
   */
  function findRelatedAlterTables(qualifiedName) {
    const [schema, tableName] = qualifiedName.split('.');
    const results = [];

    // Pattern to match ALTER TABLE statements
    const alterPattern = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w."]+[^;]*;/gi;

    // Patterns to check if the ALTER TABLE references our table
    const schemaPattern = schema === 'public'
      ? `(?:public\\.|"public"\\.|)`
      : `(?:${schema}\\.|"${schema}"\\.)`;
    const namePattern = `(?:${tableName}|"${tableName}")`;

    // Match ALTER TABLE on our table itself
    const alterOnTablePattern = new RegExp(
      `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${schemaPattern}${namePattern}\\s`,
      'i'
    );

    // Match REFERENCES to our table (foreign keys pointing to it)
    const referencesPattern = new RegExp(
      `REFERENCES\\s+${schemaPattern}${namePattern}(?:\\s|\\(|$)`,
      'i'
    );

    let match;
    while ((match = alterPattern.exec(sqlContent)) !== null) {
      const statement = match[0];
      // Check if this ALTER TABLE is on our table or references our table
      if (alterOnTablePattern.test(statement) || referencesPattern.test(statement)) {
        results.push({
          start: match.index,
          end: match.index + statement.length
        });
      }
    }

    return results;
  }

  /**
   * Actually drop the table and related ALTER TABLEs.
   */
  async function applyDropTable() {
    showDropTableConfirm = false;
    showCreateTableDialog = false;

    if (!sqlHandle || !tableToDelete) {
      showToast('No table to delete.', 'error');
      return;
    }

    try {
      // Find the CREATE TABLE statement
      const createTable = extractTableDdl(tableToDelete);
      if (!createTable) {
        showToast(`Could not find CREATE TABLE for "${tableToDelete}".`, 'error');
        return;
      }

      // Find related ALTER TABLE statements
      const alterTables = findRelatedAlterTables(tableToDelete);

      // Collect all ranges to remove, sorted by position descending
      // (so we can remove from end to start without shifting positions)
      const rangesToRemove = [
        { start: createTable.start, end: createTable.end },
        ...alterTables
      ].sort((a, b) => b.start - a.start);

      // Remove ranges from end to start
      let newSqlContent = sqlContent;
      for (const range of rangesToRemove) {
        // Also remove leading/trailing whitespace and newlines
        let start = range.start;
        let end = range.end;

        // Expand to include trailing newlines
        while (end < newSqlContent.length && (newSqlContent[end] === '\n' || newSqlContent[end] === '\r')) {
          end++;
        }

        // Expand to include leading newlines (but keep one)
        while (start > 0 && (newSqlContent[start - 1] === '\n' || newSqlContent[start - 1] === '\r')) {
          start--;
        }
        // Keep at least one newline before if there's content before
        if (start > 0 && newSqlContent[start] === '\n') {
          start++;
        }

        newSqlContent = newSqlContent.slice(0, start) + newSqlContent.slice(end);
      }

      // Clean up multiple consecutive blank lines
      newSqlContent = newSqlContent.replace(/\n{3,}/g, '\n\n').trim() + '\n';

      // Save to SQL file
      await saveToFile(sqlHandle, newSqlContent);
      sqlContent = newSqlContent;

      // Re-parse and refresh diagram
      parseResult = parsePostgresSQL(sqlContent);

      if (parseResult.errors.length > 0) {
        for (const error of parseResult.errors) {
          showToast(error.message || String(error), 'error');
        }
      }

      // Re-render current diagram with preserved positions
      if (diagramFile && selectedDiagramId) {
        const diagram = diagramFile.diagrams.find((d) => d.id === selectedDiagramId);
        if (diagram) {
          const existingPositions = getNodePositions();
          convertToFlowWithDiagram(diagram, parseResult.tables, parseResult.foreignKeys, existingPositions);
        }
      }

      const removedCount = alterTables.length;
      const message = removedCount > 0
        ? `Dropped "${tableToDelete}" and ${removedCount} related ALTER TABLE statement${removedCount > 1 ? 's' : ''}.`
        : `Dropped "${tableToDelete}".`;
      showToast(message, 'success');

      // Clear state
      tableToDelete = '';
      editingTableName = '';
      editingTableSql = '';
    } catch (err) {
      showToast(err.message || 'Failed to drop table.', 'error');
    }
  }

  /**
   * Cancel drop table confirmation.
   */
  function cancelDropTable() {
    showDropTableConfirm = false;
    tableToDelete = '';
  }

  /**
   * Center the diagram viewport on a specific table.
   * @param {string} qualifiedName
   */
  function handleCenterTable(qualifiedName) {
    const node = nodes.find((n) => n.id === qualifiedName);
    if (!node) {
      showToast(`Table "${qualifiedName}" not found in diagram.`, 'error');
      return;
    }

    if (!flowInstance) {
      showToast('Flow not initialized yet.', 'error');
      return;
    }

    // Use fitView with a filter for just this node
    flowInstance.fitView({
      nodes: [node],
      duration: 300,
      padding: 0.5,
      maxZoom: 1,
    });
  }

  // ============================================================================
  // Note CRUD operations
  // ============================================================================

  /**
   * Create a new note at the specified position.
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   */
  function handleCreateNote(screenX, screenY) {
    if (!diagramFile || !selectedDiagramId) {
      showToast('No diagram loaded.', 'error');
      return;
    }

    // Convert screen coordinates to flow coordinates
    const flowPos = flowInstance?.screenToFlowPosition({ x: screenX, y: screenY }) ?? { x: screenX, y: screenY };

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const existingNotes = diagram.notes ?? [];

    /** @type {import('./lib/parser/types.js').Note} */
    const newNote = {
      id: generateNoteId(existingNotes),
      text: '',
      x: Math.round(flowPos.x),
      y: Math.round(flowPos.y),
    };

    // Update diagram file
    const updatedNotes = [...existingNotes, newNote];
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Add note node to canvas
    const noteNode = {
      id: newNote.id,
      type: 'note',
      position: { x: newNote.x, y: newNote.y },
      data: {
        id: newNote.id,
        text: newNote.text,
        color: newNote.color,
        onTextChange: handleNoteTextChange,
      },
    };
    nodes = [...nodes, noteNode];
  }

  /**
   * Handle note text change from inline editing.
   * @param {string} noteId
   * @param {string} text
   */
  function handleNoteTextChange(noteId, text) {
    if (!diagramFile || !selectedDiagramId) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const notes = diagram.notes ?? [];
    const noteIndex = notes.findIndex((n) => n.id === noteId);
    if (noteIndex === -1) return;

    // Update note in diagram file
    const updatedNotes = [...notes];
    updatedNotes[noteIndex] = { ...notes[noteIndex], text };
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Update node data
    nodes = nodes.map((n) => {
      if (n.id === noteId && n.type === 'note') {
        return { ...n, data: { ...n.data, text } };
      }
      return n;
    });
  }

  /**
   * Handle note color change.
   * @param {string} noteId
   * @param {string | undefined} color
   */
  function handleNoteColorChange(noteId, color) {
    if (!diagramFile || !selectedDiagramId) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const notes = diagram.notes ?? [];
    const noteIndex = notes.findIndex((n) => n.id === noteId);
    if (noteIndex === -1) return;

    // Update note in diagram file
    const updatedNotes = [...notes];
    if (color === undefined) {
      const { color: _, ...rest } = notes[noteIndex];
      updatedNotes[noteIndex] = rest;
    } else {
      updatedNotes[noteIndex] = { ...notes[noteIndex], color };
    }
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Update node data
    nodes = nodes.map((n) => {
      if (n.id === noteId && n.type === 'note') {
        return { ...n, data: { ...n.data, color } };
      }
      return n;
    });
  }

  /**
   * Delete a note.
   * @param {string} noteId
   */
  function handleDeleteNote(noteId) {
    if (!diagramFile || !selectedDiagramId) return;

    const diagramIndex = diagramFile.diagrams.findIndex((d) => d.id === selectedDiagramId);
    if (diagramIndex === -1) return;

    const diagram = diagramFile.diagrams[diagramIndex];
    const notes = diagram.notes ?? [];

    // Remove note from diagram file
    const updatedNotes = notes.filter((n) => n.id !== noteId);
    const updatedDiagrams = [...diagramFile.diagrams];
    updatedDiagrams[diagramIndex] = { ...diagram, notes: updatedNotes };
    diagramFile = { ...diagramFile, diagrams: updatedDiagrams };

    // Remove node from canvas
    nodes = nodes.filter((n) => n.id !== noteId);
  }

  /**
   * Center the diagram viewport on a specific note.
   * @param {string} noteId
   */
  function handleCenterNote(noteId) {
    const node = nodes.find((n) => n.id === noteId);
    if (!node) {
      showToast(`Note not found in diagram.`, 'error');
      return;
    }

    if (!flowInstance) {
      showToast('Flow not initialized yet.', 'error');
      return;
    }

    flowInstance.fitView({
      nodes: [node],
      duration: 300,
      padding: 0.5,
      maxZoom: 1,
    });
  }

  /**
   * Trigger inline edit mode for a note.
   * @param {string} noteId
   */
  function handleEditNote(noteId) {
    // Find the note node element and trigger a double-click to enter edit mode
    const nodeEl = document.querySelector(`[data-id="${noteId}"] .note-node`);
    if (nodeEl) {
      nodeEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  }

  /**
   * Get current note positions from nodes.
   * @returns {Map<string, {x: number, y: number}>}
   */
  function getNotePositions() {
    const notePositions = new Map();
    for (const node of nodes) {
      if (node.type === 'note') {
        notePositions.set(node.id, node.position);
      }
    }
    return notePositions;
  }

  /**
   * Create note from sidebar (at center of viewport).
   */
  function handleCreateNoteFromSidebar() {
    if (!flowInstance) {
      showToast('Flow not initialized yet.', 'error');
      return;
    }
    // Get viewport center
    const viewport = flowInstance.getViewport();
    const container = document.querySelector('.svelte-flow');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // Convert to flow coordinates
    const flowPos = flowInstance.screenToFlowPosition({ x: rect.left + centerX, y: rect.top + centerY });
    handleCreateNote(rect.left + centerX, rect.top + centerY);
  }

  /**
   * Get bounds of all nodes in flow coordinates, using actual rendered dimensions.
   * @returns {{ x: number, y: number, width: number, height: number } | null}
   */
  function getNodesBoundsWithDimensions() {
    if (nodes.length === 0) return null;

    // Get current zoom level from viewport transform
    const viewport = document.querySelector('.svelte-flow__viewport');
    if (!viewport) return null;

    const transform = viewport.style.transform;
    const scaleMatch = transform.match(/scale\(([^)]+)\)/);
    const zoom = scaleMatch ? parseFloat(scaleMatch[1]) : 1;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      // Get actual rendered dimensions from DOM, adjusted for zoom
      const nodeEl = document.querySelector(`[data-id="${node.id}"]`);
      if (!nodeEl) continue;

      const rect = nodeEl.getBoundingClientRect();
      const width = rect.width / zoom;
      const height = rect.height / zoom;

      // Use flow coordinates from node position
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /**
   * Export diagram as WebP image.
   * @param {number | 'max'} pixelRatioArg - 1 for standard, 'max' for highest that fits browser limits
   */
  async function handleExport(pixelRatioArg) {
    if (nodes.length === 0) {
      showToast('No diagram to export.', 'error');
      return;
    }

    try {
      const nodesBounds = getNodesBoundsWithDimensions();
      if (!nodesBounds) {
        showToast('Failed to calculate diagram bounds.', 'error');
        return;
      }

      const padding = 30;
      const imageWidth = nodesBounds.width + padding * 2;
      const imageHeight = nodesBounds.height + padding * 2;

      const viewportElement = document.querySelector('.svelte-flow__viewport');
      if (!viewportElement) {
        showToast('Failed to capture diagram.', 'error');
        return;
      }

      // Get current background color from CSS variable
      const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();

      // Browser canvas limit (typically 16384px per dimension)
      const maxCanvasDimension = 16384;

      // Calculate pixel ratio
      let pixelRatio;
      if (pixelRatioArg === 'max') {
        // Calculate maximum pixel ratio that fits within browser limits (with small margin)
        const maxByWidth = (maxCanvasDimension - 100) / imageWidth;
        const maxByHeight = (maxCanvasDimension - 100) / imageHeight;
        // Use 2 decimal places, minimum 1x
        pixelRatio = Math.max(1, Math.floor(Math.min(maxByWidth, maxByHeight) * 100) / 100);
      } else {
        pixelRatio = pixelRatioArg;
        const canvasWidth = imageWidth * pixelRatio;
        const canvasHeight = imageHeight * pixelRatio;

        if (canvasWidth > maxCanvasDimension || canvasHeight > maxCanvasDimension) {
          showToast(`Diagram too large for ${pixelRatio}x export. Try 1x instead.`, 'error');
          return;
        }
      }

      const canvas = await toCanvas(viewportElement, {
        backgroundColor: bgColor,
        pixelRatio,
        width: imageWidth,
        height: imageHeight,
        style: {
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(${-nodesBounds.x + padding}px, ${-nodesBounds.y + padding}px)`,
        },
      });

      // Use lossy WebP with high quality, fall back to PNG if WebP fails
      let dataUrl = canvas.toDataURL('image/webp', 0.92);
      let format = 'webp';

      // Check if WebP encoding failed (returns empty or minimal data URL)
      if (!dataUrl || dataUrl === 'data:,' || dataUrl.length < 100) {
        dataUrl = canvas.toDataURL('image/png');
        format = 'png';
      }

      const link = document.createElement('a');
      link.download = `${diagramFileName.replace(/\.erd-pets\.json$/, '') || 'diagram'}.${format}`;
      link.href = dataUrl;
      link.click();

      const formatNote = format === 'png' ? ' (as PNG, WebP unavailable)' : '';
      showToast(`Exported as ${format.toUpperCase()} (${pixelRatio}x)${formatNote}.`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to export.', 'error');
    }
  }

  // Keyboard shortcuts
  $effect(() => {
    /**
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
      // Escape key cancels linking modes
      if (e.key === 'Escape') {
        if (linkingState) {
          cancelLinking();
          return;
        }
        if (arrowLinkingState) {
          cancelArrowLinking();
          return;
        }
      }

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      if (e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'o') {
        e.preventDefault();
        handleLoad();
      } else if (e.key === 'n') {
        e.preventDefault();
        handleNew();
      } else if (e.key === 'b') {
        e.preventDefault();
        showSidebar = !showSidebar;
      } else if (e.key === 'f') {
        e.preventDefault();
        showSidebar = true;
        sidebarMode = 'tables';
        focusTableSearch++;
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="app">
  <DiagramToolbar
    onNew={handleNew}
    onLoad={handleLoad}
    onRefresh={handleRefresh}
    onSave={handleSave}
    onShare={handleShare}
    onSaveAsFiles={handleSaveAsFiles}
    onDiagramChange={handleDiagramChange}
    onLayout={handleLayoutRequest}
    onEdgeStyleChange={handleEdgeStyleChange}
    onExport={handleExport}
    onAddDiagram={handleAddDiagram}
    onDiagramSettings={handleDiagramSettings}
    {diagrams}
    selectedDiagramId={selectedDiagramId}
    {hasDiagram}
    hasHandle={!!diagramHandle}
    shareSupported={isShareSupported()}
    {isSharedSession}
    {diagramFileName}
    {sqlFileName}
    {dbType}
    {edgeStyle}
    showSidebar={showSidebar}
    onToggleSidebar={() => showSidebar = !showSidebar}
  />

  <div class="main-area">
    {#if showSidebar}
      <Sidebar
        mode={sidebarMode}
        onModeChange={(mode) => sidebarMode = mode}
        tables={parseResult?.tables ?? []}
        foreignKeys={parseResult?.foreignKeys ?? []}
        visibleTables={visibleTableNames}
        onTableToggle={handleTableVisibilityToggle}
        onShowTableSql={handleShowTableSql}
        onCenterTable={handleCenterTable}
        onCreateTable={handleCreateTable}
        onCreateRelationship={handleCreateRelationship}
        onDeleteRelationship={handleDeleteRelationship}
        notes={currentNotes}
        onCenterNote={handleCenterNote}
        onCreateNote={handleCreateNoteFromSidebar}
        onEditNote={handleEditNote}
        onDeleteNote={handleDeleteNote}
        arrows={currentArrows}
        onCenterArrowFrom={handleCenterTable}
        onCenterArrowTo={handleCenterTable}
        onCreateArrow={handleCreateArrowFromSidebar}
        onDeleteArrow={handleDeleteArrow}
        focusSearch={focusTableSearch}
      />
    {/if}
    <main>
      <a
        href="https://github.com/cdacos/erd-pets"
        target="_blank"
        rel="noopener noreferrer"
        class="github-link"
        title="View on GitHub"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
      </a>
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {edgeTypes}
        fitView
        minZoom={0.1}
        onnodedragstop={recalculateEdgeHandles}
        onnodecontextmenu={handleNodeContextMenu}
        onselectioncontextmenu={handleSelectionContextMenu}
        onedgecontextmenu={handleEdgeContextMenu}
        onpaneclick={() => { closeContextMenu(); if (linkingState) cancelLinking(); if (arrowLinkingState) cancelArrowLinking(); }}
        onpanecontextmenu={handlePaneContextMenu}
      >
        <Controls />
        <MiniMap />
        <FlowInstanceCapture onCapture={(instance) => flowInstance = instance} />
      </SvelteFlow>
      {#if !hasDiagram}
        <RecentProjects
          projects={recentProjects}
          highlightKey={pendingAutoOpenKey}
          supported={isRecentSupported()}
          onOpen={openRecent}
          onRemove={removeRecent}
          onNew={handleNew}
          onLoad={handleLoad}
        />
      {/if}
    </main>
  </div>
</div>

<Toast {toasts} onDismiss={dismissToast} />

{#if contextMenu}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    tableNames={contextMenu.tableNames}
    currentColor={getTableColor(contextMenu.tableNames)}
    onColorChange={(color) => handleTableColorChange(contextMenu.tableNames, color)}
    onEditDdl={handleShowTableSql}
    onDropTable={handleDropTableRequest}
    onCreateArrow={startArrowLinking}
    onClose={closeContextMenu}
  />
{/if}

{#if paneContextMenu}
  <PaneContextMenu
    x={paneContextMenu.x}
    y={paneContextMenu.y}
    onCreateTable={handleCreateTable}
    onCreateNote={handleCreateNote}
    onClose={closeContextMenu}
  />
{/if}

{#if columnContextMenu}
  <ColumnContextMenu
    x={columnContextMenu.x}
    y={columnContextMenu.y}
    tableName={columnContextMenu.tableName}
    columnName={columnContextMenu.columnName}
    isPrimaryKey={columnContextMenu.isPrimaryKey}
    onCreateRelationship={() => startLinking(columnContextMenu.tableName, columnContextMenu.columnName)}
    onTogglePrimaryKey={() => handleTogglePrimaryKey(columnContextMenu.tableName, columnContextMenu.columnName, columnContextMenu.isPrimaryKey)}
    onClose={() => columnContextMenu = null}
  />
{/if}

{#if noteContextMenu}
  <NoteContextMenu
    x={noteContextMenu.x}
    y={noteContextMenu.y}
    noteId={noteContextMenu.noteId}
    currentColor={noteContextMenu.color}
    onColorChange={handleNoteColorChange}
    onEdit={handleEditNote}
    onDelete={handleDeleteNote}
    onCreateArrow={startArrowLinkingFromNote}
    onClose={() => noteContextMenu = null}
  />
{/if}

{#if edgeContextMenu}
  <EdgeContextMenu
    x={edgeContextMenu.x}
    y={edgeContextMenu.y}
    sourceTable={edgeContextMenu.sourceTable}
    sourceColumn={edgeContextMenu.sourceColumn}
    targetTable={edgeContextMenu.targetTable}
    targetColumn={edgeContextMenu.targetColumn}
    isArrow={edgeContextMenu.isArrow}
    onDelete={handleEdgeContextMenuDelete}
    onClose={() => edgeContextMenu = null}
  />
{/if}

<ConfirmDialog
  open={showLayoutConfirm}
  title="Apply Layout"
  message="Your current layout will be replaced. This action cannot be undone."
  confirmLabel="Apply"
  onConfirm={applyLayout}
  onCancel={cancelLayout}
/>

<ConfirmDialog
  open={showRefreshConfirm}
  title="Refresh Diagram"
  message="Refreshing will reload the diagram from disk. Unsaved changes will be lost."
  confirmLabel="Refresh"
  onConfirm={applyRefresh}
  onCancel={cancelRefresh}
/>

<ConfirmDialog
  open={showDropTableConfirm}
  title="Drop Table"
  message={`This will permanently remove "${tableToDelete}" and any foreign key constraints referencing it from the SQL file. This cannot be undone.`}
  confirmLabel="Drop Table"
  onConfirm={applyDropTable}
  onCancel={cancelDropTable}
/>

<ConfirmDialog
  open={showIntegrityCheckConfirm}
  title="Orphaned Statements Found"
  message={`Found ${pendingOrphanedAlterTables.length} ALTER TABLE statement(s) referencing non-existent tables: ${pendingOrphanedAlterTables.map(o => o.tableName).join(', ')}. Would you like to remove them from the SQL file?`}
  confirmLabel="Remove"
  cancelLabel="Skip"
  onConfirm={applyIntegrityFix}
  onCancel={skipIntegrityFix}
/>

<CreateTableDialog
  open={showCreateTableDialog}
  initialSql={editingTableSql}
  editingTable={editingTableName}
  onSubmit={handleCreateTableSubmit}
  onDropTable={handleDropTableRequest}
  onCancel={() => {
    showCreateTableDialog = false;
    editingTableName = '';
    editingTableSql = '';
  }}
/>

<CreateRelationshipDialog
  open={showCreateRelationshipDialog}
  tables={parseResult?.tables ?? []}
  initialSourceTable={prefilledSourceTable}
  initialSourceColumn={prefilledSourceColumn}
  initialTargetTable={prefilledTargetTable}
  initialTargetColumn={prefilledTargetColumn}
  onSubmit={handleCreateRelationshipSubmit}
  onCancel={() => {
    showCreateRelationshipDialog = false;
    prefilledSourceTable = '';
    prefilledSourceColumn = '';
    prefilledTargetTable = '';
    prefilledTargetColumn = '';
  }}
/>

<AddDiagramDialog
  open={showAddDiagramDialog}
  onSubmit={handleAddDiagramSubmit}
  onCancel={() => showAddDiagramDialog = false}
/>

<DiagramSettingsDialog
  open={showDiagramSettingsDialog}
  diagram={diagrams.find((d) => d.id === selectedDiagramId) ?? null}
  sqlTables={parseResult?.tables ?? []}
  onRenameDiagram={handleRenameDiagram}
  onDeleteDiagram={handleDeleteDiagram}
  onUpdateEntries={handleUpdateDiagramEntries}
  onClose={() => showDiagramSettingsDialog = false}
/>

<style>
  .app {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .main-area {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  main {
    flex: 1;
    background: var(--color-bg);
    position: relative;
  }

  .github-link {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    padding: 6px;
    border-radius: 4px;
    opacity: 0.6;
    transition: opacity 0.2s, color 0.2s;
  }

  .github-link:hover {
    opacity: 1;
    color: var(--color-text-primary);
  }

  .github-link svg {
    display: block;
  }
</style>
