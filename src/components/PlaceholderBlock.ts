// TipTap node: an AI placeholder block. A standalone box holding a one-sentence
// description of what the LLM should write there; the 🪄 Weave process expands
// these blocks later. The node is atomic, so surrounding edits can never mangle
// the description, and it round-trips through markdown as `[[ai: …]]`
// (see store/markdown.ts).
import { Node } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiPlaceholder: {
      insertAiPlaceholder: (description?: string) => ReturnType
    }
  }
}

export const AiPlaceholder = Node.create({
  name: 'aiPlaceholder',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      description: {
        default: '',
        // Serialized as a data attribute so the node survives HTML round trips
        // (markdown conversion, session save) even though the visible note is
        // regenerated on render.
        parseHTML: (el) => el.getAttribute('data-ai-placeholder') || '',
        renderHTML: (attrs) => ({ 'data-ai-placeholder': String(attrs.description ?? '') }),
      },
    }
  },

  parseHTML() {
    return [{ tag: '[data-ai-placeholder]' }]
  },

  // What editor.getHTML() emits (exports, markdown conversion). The em note
  // keeps the placeholder visible in docx/odt/PDF exports, where the
  // interactive node view does not exist.
  renderHTML({ node }) {
    const desc = String(node.attrs.description || '').trim() || '(no description yet)'
    return ['div', {}, ['p', {}, ['em', {}, `🧩 Placeholder: ${desc}`]]]
  },

  addCommands() {
    return {
      insertAiPlaceholder:
        (description: string = '') =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { description } }),
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'ph-block'

      const chip = document.createElement('span')
      chip.className = 'ph-chip'
      chip.textContent = '🧩 Placeholder'

      const input = document.createElement('input')
      input.className = 'ph-desc'
      input.type = 'text'
      input.placeholder = 'Describe what the AI should write here…'
      input.value = node.attrs.description || ''
      input.title = 'One-sentence description used as the AI prompt'

      const del = document.createElement('button')
      del.className = 'ph-delete'
      del.title = 'Remove placeholder'
      del.textContent = '✕'

      dom.append(chip, input, del)

      // The plain (non-React) node-view props don't carry the updateAttributes/
      // deleteNode helpers, so attribute updates and removal go through the
      // view's transactions directly.
      const setDesc = (value: string) => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, { description: value }),
        )
      }
      const remove = () => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        editor.view.dispatch(editor.view.state.tr.delete(pos, pos + 1)) // atom: nodeSize 1
      }

      // Stop ProseMirror from turning clicks/drags inside the controls into
      // node selection drags; the controls handle their own events.
      const isControl = (e: Event) => {
        const t = e.target as globalThis.Node | null
        return !!t && (input.contains(t) || del.contains(t))
      }
      del.addEventListener('mousedown', (e) => e.preventDefault()) // keep editor selection
      del.addEventListener('click', (e) => {
        e.preventDefault()
        remove()
      })
      input.addEventListener('mousedown', (e) => e.stopPropagation())

      // Plain keys are consumed by the input; modifier combos (Ctrl-S, Ctrl-B…)
      // still bubble so app/editor shortcuts keep working while typing here.
      input.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        e.stopPropagation()
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          input.blur()
        }
      })
      input.addEventListener('input', () => {
        setDesc(input.value)
      })

      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'aiPlaceholder') return false
          if (updated.attrs.description !== input.value) {
            input.value = updated.attrs.description || ''
          }
          return true
        },
        stopEvent: isControl,
        ignoreMutation: () => true,
      }
    }
  },
})
