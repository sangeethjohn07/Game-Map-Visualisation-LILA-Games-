import React from 'react';

const HELP_SECTIONS = [
  {
    title: '1. Select a Map',
    body: 'Choose a map from the dropdown. Only matches played on that map will appear in the match list.',
  },
  {
    title: '2. Filter by Date',
    body: 'Optionally filter matches by one or more dates. Leave empty to see all dates for the selected map.',
  },
  {
    title: '3. Pick Matches',
    body: 'Check one or more matches to load them. Search by match number, map name, or date (e.g. "Match 3", "february 10"). Sort using the ⇅ button.',
  },
  {
    title: '4. Player Trails',
    body: 'Each player gets a unique colour. Trails show movement paths. Toggle "Trails" on/off in the top bar. Use the Players panel to show/hide individuals.',
  },
  {
    title: '5. Timeline & Playback',
    body: 'Drag the scrubber to jump to any point. Press Space to play/pause. Click the speed button (1×, 2×…) to change playback speed.',
  },
  {
    title: '6. Heatmap Overlay',
    body: 'Enable Heatmap then choose Kills, Deaths, or Traffic to see density across the map.',
  },
  {
    title: '7. Right-click Player',
    body: '"All matches for player" loads every match that player appeared in on the current map.',
  },
  {
    title: '8. History',
    body: 'Each selection is auto-saved to History. Restore, rename, or delete past views — persists across sessions.',
  },
  {
    title: '9. Undo / Reset',
    body: 'The ← button undoes your last change. Reset clears all selections.',
  },
];

const SHORTCUTS = [
  ['Space',  'Play / Pause'],
  ['Scroll', 'Zoom in/out'],
  ['Drag',   'Pan canvas'],
];

export default function HelpPanel({ onClose }) {
  return (
    <div className="fixed top-0 right-0 h-full w-72 z-40 flex flex-col bg-panel border-l border-border shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border flex-none">
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Quick Guide</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition text-lg leading-none">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {HELP_SECTIONS.map(s => (
          <div key={s.title} className="bg-surface rounded p-2.5 flex flex-col gap-0.5 border border-border/50">
            <span className="text-xs font-semibold text-slate-200">{s.title}</span>
            <p className="text-[11px] text-slate-400 leading-relaxed">{s.body}</p>
          </div>
        ))}

        <div className="bg-surface rounded p-2.5 border border-border/50 flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-slate-200">Keyboard Shortcuts</span>
          {SHORTCUTS.map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <kbd className="text-[10px] bg-panel border border-border rounded px-1.5 py-0.5 font-mono text-slate-300">{key}</kbd>
              <span className="text-[11px] text-slate-400">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
