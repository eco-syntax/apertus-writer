import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  editor: Editor | null
  onInsertImage: () => void
  onWeave: () => void
  codeView: boolean
  onToggleCodeView: () => void
  autoSuggest: boolean
  onToggleAutoSuggest: () => void
  zoom: number
  onZoomChange: (z: number) => void
}

const clampZoom = (z: number) => Math.min(2, Math.max(0.5, Math.round(z * 10) / 10))

export default function Toolbar({ editor, onInsertImage, onWeave, codeView, onToggleCodeView, autoSuggest, onToggleAutoSuggest, zoom, onZoomChange }: Props) {
  const [showTableMenu, setShowTableMenu] = useState(false)
  const tableMenuRef = useRef<HTMLDivElement>(null)

  // Close the table dropdown on click-outside and Escape
  useEffect(() => {
    if (!showTableMenu) return
    const onDown = (e: MouseEvent) => {
      if (!tableMenuRef.current?.contains(e.target as Node)) setShowTableMenu(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowTableMenu(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showTableMenu])

  if (!editor) return null
  const btn = (active: boolean) => 'tb-btn' + (active ? ' active' : '')
  // Run a table command then close the menu — keeps dropdown UX simple.
  const runTable = (fn: (chain: ReturnType<Editor['chain']>) => unknown) => {
    fn(editor.chain().focus())
    setShowTableMenu(false)
  }

  return (
    <div className="toolbar">
      <select
        className="tb-select"
        disabled={codeView}
        value={
          editor.isActive('heading', { level: 1 }) ? 'h1'
          : editor.isActive('heading', { level: 2 }) ? 'h2'
          : editor.isActive('heading', { level: 3 }) ? 'h3'
          : editor.isActive('heading', { level: 4 }) ? 'h4'
          : 'p'
        }
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') editor.chain().focus().setParagraph().run()
          else editor.chain().focus().setHeading({ level: Number(v[1]) as 1|2|3|4 }).run()
        }}
      >
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
      </select>

      <span className="tb-sep" />
      <button className={btn(editor.isActive('bold'))} title="Bold (Ctrl-B)" disabled={codeView}
        onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
      <button className={btn(editor.isActive('italic'))} title="Italic (Ctrl-I)" disabled={codeView}
        onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
      <button className={btn(editor.isActive('strike'))} title="Strikethrough" disabled={codeView}
        onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></button>
      <button className={btn(editor.isActive('code'))} title="Inline code" disabled={codeView}
        onClick={() => editor.chain().focus().toggleCode().run()}>{'<>'}</button>

      <span className="tb-sep" />
      <button className={btn(editor.isActive('bulletList'))} title="Bullet list" disabled={codeView}
        onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
      <button className={btn(editor.isActive('orderedList'))} title="Numbered list" disabled={codeView}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button className={btn(editor.isActive('blockquote'))} title="Blockquote" disabled={codeView}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝ Quote</button>
      <button className={btn(editor.isActive('codeBlock'))} title="Code block" disabled={codeView}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'{ }'}</button>

      <span className="tb-sep" />
      <button className="tb-btn" title="Insert table" disabled={codeView}
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦ Table</button>
      {/* Always present (greyed out outside a table) so the toolbar doesn't
          shift around as the cursor moves in and out of tables. */}
      <span className="table-wrap" ref={tableMenuRef}>
        <button className="tb-btn" title="Edit table" disabled={codeView || !editor.isActive('table')}
          onClick={() => setShowTableMenu((v) => !v)}>Edit ▾</button>
          {showTableMenu && editor.isActive('table') && (
            <div className="table-dropdown">
              <div className="table-menu-section">Insert</div>
              <button className="tb-btn" disabled={codeView || !editor.can().addRowBefore()}
                onClick={() => runTable((c) => c.addRowBefore().run())}>↥ Row above</button>
              <button className="tb-btn" disabled={codeView || !editor.can().addRowAfter()}
                onClick={() => runTable((c) => c.addRowAfter().run())}>↧ Row below</button>
              <button className="tb-btn" disabled={codeView || !editor.can().addColumnBefore()}
                onClick={() => runTable((c) => c.addColumnBefore().run())}>⇤ Column left</button>
              <button className="tb-btn" disabled={codeView || !editor.can().addColumnAfter()}
                onClick={() => runTable((c) => c.addColumnAfter().run())}>⇥ Column right</button>
              <div className="table-menu-sep" />
              <div className="table-menu-section">Delete</div>
              <button className="tb-btn" disabled={codeView || !editor.can().deleteRow()}
                onClick={() => runTable((c) => c.deleteRow().run())}>✕ Row</button>
              <button className="tb-btn" disabled={codeView || !editor.can().deleteColumn()}
                onClick={() => runTable((c) => c.deleteColumn().run())}>✕ Column</button>
              <button className="tb-btn" disabled={codeView} onClick={() => runTable((c) => c.deleteTable().run())}>✕ Table</button>
              <div className="table-menu-sep" />
              <div className="table-menu-section">Cell</div>
              <button className="tb-btn" disabled={codeView || !editor.can().mergeCells()}
                onClick={() => runTable((c) => c.mergeCells().run())}>⌗ Merge cells</button>
              <button className="tb-btn" disabled={codeView || !editor.can().splitCell()}
                onClick={() => runTable((c) => c.splitCell().run())}>⌘ Split cell</button>
              <button className="tb-btn" disabled={codeView} onClick={() => runTable((c) => c.toggleHeaderRow().run())}>
                Header row</button>
            </div>
          )}
      </span>
      <button className="tb-btn" title="Insert image" disabled={codeView} onClick={onInsertImage}>🖼 Image</button>
      <button className="tb-btn" title="Horizontal rule" disabled={codeView}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</button>

      <span className="tb-sep" />
      <button className="tb-btn" title="Insert an AI placeholder block (expanded later by Weave)" disabled={codeView}
        onClick={() => editor.chain().focus().insertAiPlaceholder().run()}>🧩 Placeholder</button>
      <button className="tb-btn" title="Generate AI content for every placeholder block" disabled={codeView}
        onClick={onWeave}>🪄 Weave</button>

      <span className="tb-sep" />
      <button className="tb-btn" title="Undo" disabled={codeView} onClick={() => editor.chain().focus().undo().run()}>↶</button>
      <button className="tb-btn" title="Redo" disabled={codeView} onClick={() => editor.chain().focus().redo().run()}>↷</button>

      <span className="tb-sep" />
      <button className={btn(autoSuggest)} title="Auto-suggest on typing pause (AI)"
        disabled={codeView} onClick={onToggleAutoSuggest}>✨ Auto</button>
      <button className={btn(codeView)} title="Toggle raw markdown code view (Ctrl+Shift+M)"
        onClick={onToggleCodeView}>{'</> Code'}</button>

      <span className="tb-sep" />
      <button className="tb-btn" title="Zoom out" disabled={codeView}
        onClick={() => onZoomChange(clampZoom(zoom - 0.1))}>−</button>
      <button className="tb-btn" title="Reset zoom (100%)" disabled={codeView}
        onClick={() => onZoomChange(1)}>{Math.round(zoom * 100)}%</button>
      <button className="tb-btn" title="Zoom in" disabled={codeView}
        onClick={() => onZoomChange(clampZoom(zoom + 0.1))}>+</button>
    </div>
  )
}
