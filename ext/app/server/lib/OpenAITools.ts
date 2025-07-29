import { OpenAITool } from "app/server/lib/IAssistant";

export const OPENAI_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "get_tables",
      description: "Returns all tables in a Grist document.",
    },
  },
  {
    type: "function",
    function: {
      name: "add_table",
      description: "Adds a table to a Grist document.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to add.",
          },
          columns: {
            type: ["array", "null"],
            description:
              "The columns to create the table with. " +
              "Null if the table should be created with default columns ('A', 'B', 'C').",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "The column ID.",
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
        required: ["table_id", "columns"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "rename_table",
      description: "Renames a table in a Grist document.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to rename.",
          },
          new_table_id: {
            type: "string",
            description: "The new ID of the table.",
          },
        },
        required: ["table_id", "new_table_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "remove_table",
      description: "Removes a table from a Grist document.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to remove.",
          },
        },
        required: ["table_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_table_columns",
      description: "Returns all columns in a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table.",
          },
        },
        required: ["table_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "add_table_column",
      description: "Adds a column to a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to add the column to.",
          },
          column_id: {
            type: "string",
            description: "The ID of the column to add.",
          },
          column_options: {
            type: ["object", "null"],
            description:
              "The options to create the column with. " +
              'Example: `{"type": "Text", "label": "Name"}`',
            properties: {
              type: {
                type: "string",
                enum: [
                  "Any",
                  "Text",
                  "Numeric",
                  "Int",
                  "Bool",
                  "Date",
                  "DateTime",
                  "Choice",
                  "ChoiceList",
                  "Ref",
                  "RefList",
                  "Attachments",
                ],
                description: "The column type.",
              },
              text_format: {
                type: "string",
                enum: ["text", "markdown", "hyperlink"],
                description:
                  "The format of Text columns. " +
                  "If unset, defaults to text.",
              },
              number_show_spinner: {
                type: "boolean",
                description:
                  "Whether to show increment/decrement buttons. " +
                  "If unset, defaults to false.",
              },
              number_format: {
                type: "string",
                enum: ["text", "currency", "decimal", "percent", "scientific"],
                description:
                  "The format of Int and Numeric columns. " +
                  "If unset, defaults to text.",
              },
              number_currency_code: {
                type: ["string", "null"],
                description:
                  "ISO 4217 currency code (e.g. 'USD', 'GBP', 'JPY'). " +
                  "Uses the document's currency if null or unset. " +
                  "Only applies if number_format is currency.",
              },
              number_minus_sign: {
                type: "string",
                enum: ["minus", "parens"],
                description:
                  "How to format negative numbers. " +
                  "If unset, defaults to minus.",
              },
              number_min_decimals: {
                type: "number",
                description:
                  "Minimum number of decimals for Int and Numeric columns.",
                minimum: 0,
                maximum: 20,
              },
              number_max_decimals: {
                type: "number",
                description:
                  "Maximum number of decimals for Int and Numeric columns.",
                minimum: 0,
                maximum: 20,
              },
              toggle_format: {
                type: "string",
                enum: ["text", "checkbox", "switch"],
                description:
                  "The format of Bool/Toggle columns. " +
                  "If unset, defaults to checkbox.",
              },
              reference_table_id: {
                type: "string",
                description:
                  "The ID of the referenced table. " +
                  "Required if type is Ref or RefList.",
              },
              date_format: {
                type: "string",
                enum: [
                  "YYYY-MM-DD",
                  "MM-DD-YYYY",
                  "MM/DD/YYYY",
                  "MM-DD-YY",
                  "MM/DD/YY",
                  "DD MMM YYYY",
                  "MMMM Do, YYYY",
                  "DD-MM-YYYY",
                  "custom",
                ],
                description:
                  "The date format of Date and DateTime columns. " +
                  "If custom, date_custom_format must be set.",
              },
              date_custom_format: {
                type: "string",
                description:
                  "A Moment.js date format string (e.g. 'ddd, hA'). " +
                  "Only applied if date_format is custom.",
              },
              time_format: {
                type: "string",
                enum: [
                  "h:mma",
                  "h:mma z",
                  "HH:mm",
                  "HH:mm z",
                  "HH:mm:ss",
                  "HH:mm:ss z",
                  "custom",
                ],
                description:
                  "The time format of DateTime columns. " +
                  "If custom, time_custom_format must be set.",
              },
              time_custom_format: {
                type: "string",
                description:
                  "A Moment.js time format string (e.g. 'h:mm a'). " +
                  "Only applied if time_format is custom.",
              },
              timezone: {
                type: "string",
                description:
                  "The IANA TZ identifier (e.g. 'America/New_York') for DateTime columns. " +
                  "If unset, the document's timezone will be used.",
              },
              attachment_height: {
                type: "number",
                description: "Height of attachment thumbnails in pixels. ",
                minimum: 16,
                maximum: 96,
              },
              label: {
                type: "string",
                description: "The column label.",
              },
              formula: {
                type: ["string", "null"],
                description:
                  "The column formula. " +
                  "Must be Grist-compatible Python syntax (e.g. `$Amount * 1.1`).",
              },
              formula_type: {
                type: ["string", "null"],
                enum: ["regular", "trigger"],
                description:
                  "The formula type. " +
                  "Regular formulas always recalculate whenever the document is loaded or modified. " +
                  "Trigger formulas only recalculate according to formula_recalc_behavior. " +
                  "Required if formula is not null.",
              },
              untie_col_id_from_label: {
                type: "boolean",
                description:
                  "True if column ID should not be automatically changed to match label.",
              },
              description: {
                type: "string",
                description: "The column description.",
              },
              text_alignment: {
                type: "string",
                enum: ["left", "center", "right"],
                description: "The column text alignment.",
              },
              text_wrap: {
                type: "boolean",
                description: "True if text in the column should wrap to fit.",
              },
              choices: {
                type: "array",
                description:
                  "List of valid choices. " +
                  "Only applicable to Choice and ChoiceList columns.",
                items: {
                  type: "string",
                },
              },
              choice_styles: {
                type: "object",
                description:
                  "Optional styles for choices. " +
                  "Keys are valid choices (e.g., 'Name', 'Age'). " +
                  "Values are objects with keys: " +
                  "textColor, fillColor, fontUnderline, fontItalic, and fontStrikethrough. " +
                  "Colors must be in six-value hexadecimal syntax. " +
                  'Example: `{"Choice 1": {"textColor": "#FFFFFF", "fillColor": "#16B378", ' +
                  '"fontUnderline": false, "fontItalic": false, "fontStrikethrough": false}}`',
              },
              cell_text_color: {
                type: "string",
                description:
                  "The cell text color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#FFFFFF"`',
              },
              cell_fill_color: {
                type: "string",
                description:
                  "The cell fill color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#16B378"`',
              },
              cell_bold: {
                type: "boolean",
                description: "If cell text should be bolded.",
              },
              cell_underline: {
                type: "boolean",
                description: "If cell text should be underlined.",
              },
              cell_italic: {
                type: "boolean",
                description: "If cell text should be italicized.",
              },
              cell_strikethrough: {
                type: "boolean",
                description:
                  "If cell text should have a horizontal line through the center.",
              },
              header_text_color: {
                type: "string",
                description:
                  "The column header text color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#FFFFFF"`',
              },
              header_fill_color: {
                type: "string",
                description:
                  "The column header fill color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#16B378"`',
              },
              header_bold: {
                type: "boolean",
                description: "If the header text should be bolded.",
              },
              header_underline: {
                type: "boolean",
                description: "If the header text should be underlined.",
              },
              header_italic: {
                type: "boolean",
                description: "If the header text should be italicized.",
              },
              header_strikethrough: {
                type: "boolean",
                description:
                  "If the header text should have a horizontal line through the center.",
              },
              conditional_formatting_rules: {
                description:
                  "Not yet supported. Must be configured manually in the creator panel.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["table_id", "column_id", "column_options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_table_column",
      description: "Updates a column in a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table containing the column.",
          },
          column_id: {
            type: "string",
            description: "The ID of the column to update.",
          },
          column_options: {
            type: "object",
            description:
              "The column options to update. " +
              "Only include fields to set/update. " +
              'Example: `{"type": "Text", "label": "Name"}`',
            properties: {
              id: {
                type: "string",
                description: "The column ID.",
              },
              type: {
                type: "string",
                enum: [
                  "Any",
                  "Text",
                  "Numeric",
                  "Int",
                  "Bool",
                  "Date",
                  "DateTime",
                  "Choice",
                  "ChoiceList",
                  "Ref",
                  "RefList",
                  "Attachments",
                ],
                description: "The column type.",
              },
              text_format: {
                type: "string",
                enum: ["text", "markdown", "hyperlink"],
                description:
                  "The format of Text columns. " +
                  "If unset, defaults to text.",
              },
              number_show_spinner: {
                type: "boolean",
                description:
                  "Whether to show increment/decrement buttons. " +
                  "If unset, defaults to false.",
              },
              number_format: {
                type: "string",
                enum: ["text", "currency", "decimal", "percent", "scientific"],
                description:
                  "The format of Int and Numeric columns. " +
                  "If unset, defaults to text.",
              },
              number_currency_code: {
                type: "string",
                description:
                  "ISO 4217 currency code (e.g. 'USD', 'GBP', 'JPY'). " +
                  "Uses the document's currency if null or unset. " +
                  "Only applies if number_format is currency.",
              },
              number_minus_sign: {
                type: "string",
                enum: ["minus", "parens"],
                description:
                  "How to format negative numbers. " +
                  "If unset, defaults to minus.",
              },
              number_min_decimals: {
                type: "number",
                description:
                  "Minimum number of decimals for Int and Numeric columns.",
                minimum: 0,
                maximum: 20,
              },
              number_max_decimals: {
                type: "number",
                description:
                  "Maximum number of decimals for Int and Numeric columns.",
                minimum: 0,
                maximum: 20,
              },
              toggle_format: {
                type: "string",
                enum: ["text", "checkbox", "switch"],
                description:
                  "The format of Bool/Toggle columns. " +
                  "If unset, defaults to checkbox.",
              },
              reference_table_id: {
                type: "string",
                description:
                  "The ID of the referenced table. " +
                  "Required if type is Ref or RefList.",
              },
              reference_show_column_id: {
                type: "string",
                description:
                  "The ID of the column from the referenced table to show. " +
                  "Required if type is Ref or RefList.",
              },
              date_format: {
                type: "string",
                enum: [
                  "YYYY-MM-DD",
                  "MM-DD-YYYY",
                  "MM/DD/YYYY",
                  "MM-DD-YY",
                  "MM/DD/YY",
                  "DD MMM YYYY",
                  "MMMM Do, YYYY",
                  "DD-MM-YYYY",
                  "custom",
                ],
                description:
                  "The date format of Date and DateTime columns. " +
                  "If custom, date_custom_format must be set.",
              },
              date_custom_format: {
                type: "string",
                description:
                  "A Moment.js date format string (e.g. 'ddd, hA'). " +
                  "Only applied if date_format is custom.",
              },
              time_format: {
                type: "string",
                enum: [
                  "h:mma",
                  "h:mma z",
                  "HH:mm",
                  "HH:mm z",
                  "HH:mm:ss",
                  "HH:mm:ss z",
                  "custom",
                ],
                description:
                  "The time format of DateTime columns. " +
                  "If custom, time_custom_format must be set.",
              },
              time_custom_format: {
                type: "string",
                description:
                  "A Moment.js time format string (e.g. 'h:mm a'). " +
                  "Only applied if time_format is custom.",
              },
              timezone: {
                type: "string",
                description:
                  "The IANA TZ identifier (e.g. 'America/New_York') for DateTime columns. " +
                  "If unset, the document's timezone will be used.",
              },
              attachment_height: {
                type: "number",
                description: "Height of attachment thumbnails in pixels. ",
                minimum: 16,
                maximum: 96,
              },
              label: {
                type: "string",
                description: "The column label.",
              },
              formula: {
                type: ["string", "null"],
                description:
                  "The column formula. " +
                  "Must be Grist-compatible Python syntax (e.g. `$Amount * 1.1`).",
              },
              formula_type: {
                type: ["string", "null"],
                enum: ["regular", "trigger"],
                description:
                  "The formula type. " +
                  "Regular formulas always recalculate whenever the document is loaded or data is changed. " +
                  "Trigger formulas only recalculate according to formula_recalc_behavior. " +
                  "Required if formula is not null.",
              },
              formula_recalc_behavior: {
                type: "string",
                enum: ["add-record", "add-or-update-record", "custom", "never"],
                description:
                  "When to recalculate the trigger formula. " +
                  "add-record only calculates the formula when a record is first added. " +
                  "add-or-update-record also recalculates the formula whenever a record updated. " +
                  "custom only recalculates the formula whenever a record is added or " +
                  "a column in formula_recalc_col_ids is updated.",
              },
              formula_recalc_col_ids: {
                type: "array",
                description:
                  "If any of these columns change, the formula will be recalculated. " +
                  "Required if formula_recalc_behavior is custom.",
                items: {
                  type: "string",
                },
              },
              untie_col_id_from_label: {
                type: "boolean",
                description:
                  "True if column ID should not be automatically changed to match label.",
              },
              description: {
                type: "string",
                description: "The column description.",
              },
              text_alignment: {
                type: "string",
                enum: ["left", "center", "right"],
                description: "The column text alignment.",
              },
              text_wrap: {
                type: "boolean",
                description: "True if text in the column should wrap to fit.",
              },
              choices: {
                type: "array",
                description:
                  "List of valid choices. " +
                  "Only applicable to Choice and ChoiceList columns.",
                items: {
                  type: "string",
                },
              },
              choice_styles: {
                type: "object",
                description:
                  "Optional styles for choices. " +
                  "Keys are valid choices (e.g., 'Name', 'Age'). " +
                  "Values are objects with keys: " +
                  "textColor, fillColor, fontUnderline, fontItalic, and fontStrikethrough. " +
                  "Colors must be in six-value hexadecimal syntax. " +
                  'Example: `{"Choice 1": {"textColor": "#FFFFFF", "fillColor": "#16B378", ' +
                  '"fontUnderline": false, "fontItalic": false, "fontStrikethrough": false}}`',
              },
              cell_text_color: {
                type: "string",
                description:
                  "The cell text color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#FFFFFF"`',
              },
              cell_fill_color: {
                type: "string",
                description:
                  "The cell fill color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#16B378"`',
              },
              cell_bold: {
                type: "boolean",
                description: "If cell text should be bolded.",
              },
              cell_underline: {
                type: "boolean",
                description: "If cell text should be underlined.",
              },
              cell_italic: {
                type: "boolean",
                description: "If cell text should be italicized.",
              },
              cell_strikethrough: {
                type: "boolean",
                description:
                  "If cell text should have a horizontal line through the center.",
              },
              header_text_color: {
                type: "string",
                description:
                  "The column header text color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#FFFFFF"`',
              },
              header_fill_color: {
                type: "string",
                description:
                  "The column header fill color. " +
                  "Must be a six-value hexadecimal string. " +
                  'Example: `"#16B378"`',
              },
              header_bold: {
                type: "boolean",
                description: "If the header text should be bolded.",
              },
              header_underline: {
                type: "boolean",
                description: "If the header text should be underlined.",
              },
              header_italic: {
                type: "boolean",
                description: "If the header text should be italicized.",
              },
              header_strikethrough: {
                type: "boolean",
                description:
                  "If the header text should have a horizontal line through the center.",
              },
              conditional_formatting_rules: {
                description:
                  "Not yet supported. Must be configured manually in the creator panel.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["table_id", "column_id", "column_options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_table_column",
      description: "Removes a column from a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table containing the column.",
          },
          column_id: {
            type: "string",
            description: "The ID of the column to remove.",
          },
        },
        required: ["table_id", "column_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_pages",
      description: "Returns all pages in a Grist document.",
    },
  },
  {
    type: "function",
    function: {
      name: "update_page",
      description: "Updates a page in a Grist document.",
      parameters: {
        type: "object",
        properties: {
          page_id: {
            type: "integer",
            description: "The ID of the page to update.",
          },
          page_options: {
            type: "object",
            description:
              "The page options to update. " +
              "Only include fields to set/update. " +
              'Example: `{"name": "Name"}`',
            properties: {
              name: {
                type: "string",
                description: "The page name.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["page_id", "page_options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_page",
      description: "Removes a page from a Grist document.",
      parameters: {
        type: "object",
        properties: {
          page_id: {
            type: "integer",
            description: "The ID of the page to remove.",
          },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_widgets",
      description: "Returns all widgets in a page.",
      parameters: {
        type: "object",
        properties: {
          page_id: {
            type: "integer",
            description: "The ID of the page containing the widgets.",
          },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "add_page_widget",
      description: "Adds a widget to a page.",
      parameters: {
        type: "object",
        properties: {
          page_id: {
            type: ["integer", "null"],
            description:
              "The ID of the page to add the widget to. " +
              "If null, a new page will be created.",
          },
          widget_options: {
            type: "object",
            description:
              "The options to create the widget with. " +
              "Only include fields to set/update. " +
              'Example: `{"title": "Title", "type": "table"}`',
            properties: {
              table_id: {
                type: ["string", "null"],
                description:
                  "The ID of the table to show data from. " +
                  "If null, a new table will be created.",
              },
              type: {
                type: "string",
                enum: ["table", "card", "card_list", "custom"],
                description:
                  "The widget type. " +
                  "The following types are not yet supported: 'chart', 'form'.",
              },
              group_by_column_ids: {
                type: ["array"],
                description:
                  "If table_id is not null, the IDs of the columns to group records by.",
                items: {
                  type: ["string"],
                },
              },
              custom_widget_id: {
                type: "string",
                description:
                  "The widget ID of one of the widgets from get_available_custom_widgets. " +
                  "Must set this or custom_widget_url if type is 'custom'.",
              },
              custom_widget_url: {
                type: "string",
                description:
                  "Public URL to a Grist custom widget. " +
                  "Must set this or custom_widget_id if type is 'custom'.",
              },
              title: {
                type: "string",
                description: "The widget title.",
              },
              description: {
                type: "string",
                description: "The widget description.",
              },
            },
            required: ["table_id", "type"],
            additionalProperties: false,
          },
        },
        required: ["page_id", "widget_options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_page_widget",
      description: "Updates a widget in a page.",
      parameters: {
        type: "object",
        properties: {
          widget_id: {
            type: "integer",
            description: "The ID of the widget to update.",
          },
          widget_options: {
            type: "object",
            description:
              "The widget options to update. " +
              "Only include fields to set/update. " +
              'Example: `{"title": "Title", "type": "table"}`',
            properties: {
              type: {
                type: "string",
                enum: ["table", "card", "card_list", "custom"],
                description:
                  "The widget type. " +
                  "The following types are not yet supported: 'chart', 'form'.",
              },
              custom_widget_id: {
                type: "string",
                description:
                  "The widget ID of one of the widgets from get_available_custom_widgets. " +
                  "Must set this or custom_widget_url if type is 'custom'.",
              },
              custom_widget_url: {
                type: "string",
                description:
                  "Public URL to a Grist custom widget. " +
                  "Must set this or custom_widget_id if type is 'custom'.",
              },
              title: {
                type: "string",
                description: "The widget title.",
              },
              description: {
                type: "string",
                description: "The widget description.",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["widget_id", "widget_options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_page_widget",
      description:
        "Removes a widget from a page. " +
        "If the widget is the only one on the page, the page will also be removed.",
      parameters: {
        type: "object",
        properties: {
          widget_id: {
            type: "integer",
            description: "The ID of the widget to remove.",
          },
        },
        required: ["widget_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_widget_select_by_options",
      description:
        "Returns all other widgets on the same page that can be linked to this widget. " +
        "When linked, selecting a record in the other widget will cause this widget to " +
        "update and show only the data related to the selected record.",
      parameters: {
        type: "object",
        properties: {
          widget_id: {
            type: "integer",
            description: "The ID of the widget.",
          },
        },
        required: ["widget_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "set_page_widget_select_by",
      description:
        "Links this widget to another widget in the same page. " +
        "When linked, selecting a record in the other widget will cause this widget to " +
        "update and show only the data related to the selected record.",
      parameters: {
        type: "object",
        properties: {
          widget_id: {
            type: "integer",
            description: "The ID of the widget to link.",
          },
          widget_select_by: {
            type: ["object", "null"],
            description:
              "The options to link this widget with. " +
              "Must be one of the options returned by get_page_widget_select_by_options. " +
              "If null, this widget will be unlinked. ",
            properties: {
              link_from_widget_id: {
                type: "integer",
                description: "The widget to link this widget to.",
              },
              link_from_column_id: {
                type: ["string", "null"],
                description:
                  "The column in link_from_widget_id to use for matching records in the linked widget. " +
                  "If null, records will be matched by row ID - useful for linking 2 widgets for the same table.",
              },
              link_to_column_id: {
                type: ["string", "null"],
                description:
                  "The column in link_to_widget_id to use for matching records from link_from_widget_id. " +
                  "If null, all rows matching link_from_column_id will be shown in the linked widget.",
              },
            },
            required: [
              "link_from_widget_id",
              "link_from_column_id",
              "link_to_column_id",
            ],
            additionalProperties: false,
          },
        },
        required: ["widget_id", "widget_select_by"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_available_custom_widgets",
      description: "Returns all available custom widgets in a Grist document.",
    },
  },
  {
    type: "function",
    function: {
      name: "query_document",
      description:
        "Runs a SQL SELECT query against a Grist document and returns matching rows. " +
        "Only SQLite-compatible SQL is supported.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A SQL SELECT query to run on the Grist document. " +
              "Must be a single SELECT statement with no trailing semicolon. " +
              "WITH clauses are permitted. " +
              "Must be valid SQLite syntax.",
          },
          args: {
            type: ["array", "null"],
            description:
              "Arguments for parameters in query. " +
              "Null if query is not parameterized.",
            items: {
              type: ["string", "number", "boolean", "null"],
            },
          },
        },
        required: ["query", "args"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "add_records",
      description: "Adds one or more records to a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to add the records to.",
          },
          records: {
            type: "array",
            description: "The records to add.",
            items: {
              type: "object",
              description:
                "A record. Keys are column IDs (e.g., 'Name', 'Age'). " +
                'Example: `{"Name": "Alice", "Age": 30}`',
            },
          },
        },
        required: ["table_id", "records"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_records",
      description: "Updates one or more records in a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to update the records in.",
          },
          record_ids: {
            type: "array",
            description: "The IDs of the records to update.",
            items: {
              type: "number",
            },
          },
          records: {
            type: "array",
            description:
              "The records to update, in the same order as record_ids.",
            items: {
              description:
                "A record. Keys are column IDs (e.g., 'Name', 'Age'). " +
                'Example: `{"Name": "Alice", "Age": 30}`',
            },
          },
        },
        required: ["table_id", "record_ids", "records"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_records",
      description: "Removes one or more records from a table.",
      parameters: {
        type: "object",
        properties: {
          table_id: {
            type: "string",
            description: "The ID of the table to remove the records from.",
          },
          record_ids: {
            type: "array",
            description: "The IDs of the records to remove.",
            items: {
              type: "number",
            },
          },
        },
        required: ["table_id", "record_ids"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];
