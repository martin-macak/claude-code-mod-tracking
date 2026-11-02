// Captures of Claude Code 2.1.316 (issue #208, docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-01): a probe plugin wrote
// `e` and the answer of `next(e)` of each AskUserQuestion call. The values are word for word. The folder of the spike holds the files.
import type { ToolCallEvent } from '../../core/interfaces/events'

/** A text and a number question: the answers are plain strings in `answers`. The engine kept `options: []` and every field of the control. */
export const LIVE_TEXT_NUMBER: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_tn_1',
  input: {
    questions: [
      {
        question: 'What is the project name?',
        header: 'Name',
        kind: 'text',
        placeholder: 'my-project',
        multiSelect: false,
      },
      {
        question: 'How many slides?',
        header: 'Slides',
        kind: 'number',
        min: 1,
        max: 20,
        step: 1,
        defaultValue: 5,
        unit: 'slides',
        multiSelect: false,
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_tn_1',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'What is the project name?',
          header: 'Name',
          kind: 'text',
          options: [],
          multiSelect: false,
          placeholder: 'my-project',
        },
        {
          question: 'How many slides?',
          header: 'Slides',
          kind: 'number',
          options: [],
          multiSelect: false,
          min: 1,
          max: 20,
          step: 1,
          defaultValue: 5,
          unit: 'slides',
        },
      ],
      answers: {
        'What is the project name?': 'acme-app',
        'How many slides?': '12',
      },
      annotations: {},
    },
    text: 'The user answered: "What is the project name?"="acme-app", "How many slides?"="12". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
    isReadOnly: true,
  },
} as unknown as ToolCallEvent

/** A multi-select whose label `A, custom` holds a comma, picked next to `A` and a typed piece: the engine quotes the label. */
export const LIVE_COMMA_LABEL: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_comma_1',
  input: {
    questions: [
      {
        question: 'Which variants?',
        header: 'Variants',
        multiSelect: true,
        options: [
          {
            label: 'A',
            description: 'plain',
          },
          {
            label: 'A, custom',
            description: 'has a comma',
          },
          {
            label: 'B',
            description: 'other',
          },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_comma_1',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'Which variants?',
          header: 'Variants',
          options: [
            {
              label: 'A',
              description: 'plain',
            },
            {
              label: 'A, custom',
              description: 'has a comma',
            },
            {
              label: 'B',
              description: 'other',
            },
          ],
          multiSelect: true,
          kind: 'choice',
        },
      ],
      answers: {
        'Which variants?': 'A, "A, custom", typed piece',
      },
      annotations: {},
    },
    text: 'The user answered: "Which variants?"="A, "A, custom", typed piece". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
    isReadOnly: true,
  },
} as unknown as ToolCallEvent

/** A typed multi-select piece that holds a quote and a comma: the engine quotes it as a JSON string, with a backslash before each inner quote. */
export const LIVE_QUOTE_PIECE: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_quote_1',
  input: {
    questions: [
      {
        question: 'Which extras?',
        header: 'Extras',
        multiSelect: true,
        options: [
          {
            label: 'Lint',
            description: 'lint',
          },
          {
            label: 'Tests',
            description: 'tests',
          },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_quote_1',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'Which extras?',
          header: 'Extras',
          options: [
            {
              label: 'Lint',
              description: 'lint',
            },
            {
              label: 'Tests',
              description: 'tests',
            },
          ],
          multiSelect: true,
          kind: 'choice',
        },
      ],
      answers: {
        'Which extras?': 'Lint, "say \\"hi\\", ok"',
      },
      annotations: {},
    },
    text: 'The user answered: "Which extras?"="Lint, "say \\"hi\\", ok"". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
    isReadOnly: true,
  },
} as unknown as ToolCallEvent

/** Three questions: a typed piece with a quote and no comma (quoted), a typed piece with a backslash only (plain), a single typed answer with a quote and a comma (plain). */
export const LIVE_QUOTE_ONLY: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_more_1',
  input: {
    questions: [
      {
        question: 'Quote only?',
        header: 'Q1',
        multiSelect: true,
        options: [
          {
            label: 'Lint',
            description: 'l',
          },
          {
            label: 'Tests',
            description: 't',
          },
        ],
      },
      {
        question: 'Backslash?',
        header: 'Q2',
        multiSelect: true,
        options: [
          {
            label: 'Lint',
            description: 'l',
          },
          {
            label: 'Tests',
            description: 't',
          },
        ],
      },
      {
        question: 'Single typed?',
        header: 'Q3',
        multiSelect: false,
        options: [
          {
            label: 'Yes',
            description: 'y',
          },
          {
            label: 'No',
            description: 'n',
          },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_more_1',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'Quote only?',
          header: 'Q1',
          options: [
            {
              label: 'Lint',
              description: 'l',
            },
            {
              label: 'Tests',
              description: 't',
            },
          ],
          multiSelect: true,
        },
        {
          question: 'Backslash?',
          header: 'Q2',
          options: [
            {
              label: 'Lint',
              description: 'l',
            },
            {
              label: 'Tests',
              description: 't',
            },
          ],
          multiSelect: true,
        },
        {
          question: 'Single typed?',
          header: 'Q3',
          options: [
            {
              label: 'Yes',
              description: 'y',
            },
            {
              label: 'No',
              description: 'n',
            },
          ],
          multiSelect: false,
        },
      ],
      answers: {
        'Quote only?': 'Lint, "a \\"q\\" b"',
        'Backslash?': 'Lint, c\\d',
        'Single typed?': 'x, "y"',
      },
      annotations: {},
    },
    text: 'The user answered: "Quote only?"="Lint, "a \\"q\\" b"", "Backslash?"="Lint, c\\d", "Single typed?"="x, "y"". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
    isReadOnly: true,
  },
} as unknown as ToolCallEvent

/** A dialog that nobody answered: `answers` is empty and `afkTimeoutMs` holds the timeout (`CLAUDE_AFK_TIMEOUT_MS=8000`). */
export const LIVE_AFK: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_afk_1',
  input: {
    questions: [
      {
        question: 'Where should the records live?',
        header: 'Storage',
        multiSelect: false,
        options: [
          {
            label: 'State only',
            description: 'Keep them in the plugin state.',
          },
          {
            label: 'State and store',
            description: 'Also write them to the plugin store.',
          },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_afk_1',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'Where should the records live?',
          header: 'Storage',
          options: [
            {
              label: 'State only',
              description: 'Keep them in the plugin state.',
            },
            {
              label: 'State and store',
              description: 'Also write them to the plugin store.',
            },
          ],
          multiSelect: false,
        },
      ],
      answers: {},
      annotations: {},
      afkTimeoutMs: 8000,
    },
    text: "No response after 8s — the user may be away from keyboard. Proceed using your best judgment based on the context so far; you can re-ask this question later if it's still relevant.",
    isReadOnly: true,
  },
} as unknown as ToolCallEvent

/** The terminal dialog, "Chat about this": an error result with the words of the engine, and none of `followUp` and `response`. */
export const LIVE_CHAT_ABOUT_THIS: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_chat_1',
  input: {
    questions: [
      {
        question: 'Where should the records live?',
        header: 'Storage',
        multiSelect: false,
        options: [
          {
            label: 'State only',
            description: 'Keep them in the plugin state.',
          },
          {
            label: 'State and store',
            description: 'Also write them to the plugin store.',
          },
        ],
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_chat_1',
  },
  result: {
    ref: 1,
    result:
      'Error: The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "Where should the records live?"\n  (No answer provided)',
    text: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "Where should the records live?"\n  (No answer provided)',
    isError: true,
  },
} as unknown as ToolCallEvent

/** A `$.ui.ask` of a second plugin: the id starts with `toolu_plugin_`, and no field names the plugin. */
export const LIVE_PLUGIN_ASK: ToolCallEvent = {
  tool: 'AskUserQuestion',
  toolUseId: 'toolu_plugin_8576f25e46234ddab0f7bb970150b5b2',
  input: {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        options: [
          {
            label: 'Red',
            description: '',
          },
          {
            label: 'Blue',
            description: '',
          },
        ],
        multiSelect: false,
      },
    ],
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_plugin_8576f25e46234ddab0f7bb970150b5b2',
  },
  result: {
    ref: 1,
    result: {
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          options: [
            {
              label: 'Red',
              description: '',
            },
            {
              label: 'Blue',
              description: '',
            },
          ],
          multiSelect: false,
        },
      ],
      answers: {
        'Which colour?': 'Blue',
      },
      annotations: {},
    },
    text: 'Your questions have been answered: "Which colour?"="Blue". You can now continue with these answers in mind.',
    isReadOnly: true,
  },
} as unknown as ToolCallEvent
