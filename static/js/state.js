import { SelectionState } from './selection.js';

export const state = {
  roots: [],
  source: { path: null, entries: [] },
  dest: { path: null, entries: [] },
  selection: new SelectionState(),     // Selection in the SOURCE pane  (drives Transfer)
  destSelection: new SelectionState(), // Selection in the DEST pane   (mkdir/rename/delete target)
  historyTab: 'active', // 'active' | 'activity'
  tasks: [],
  activeTaskId: null,
  finishedTaskIds: new Set(), // task ids whose completion was already handled
  activity: [], // [{id, kind, message, created_at}] newest-first
  singlePane: (typeof localStorage !== 'undefined' ? localStorage.getItem('litesync-dual-pane') : null) !== 'true',
  pickerDest: { path: null, entries: [] },
  pickerDestSelection: new SelectionState(), // Selection object for modal picker, just to keep renderPane happy
};

