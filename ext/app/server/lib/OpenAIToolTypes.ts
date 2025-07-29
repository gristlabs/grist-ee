import OpenAIToolTypesTI from "app/server/lib/OpenAIToolTypes-ti";
import { CheckerT, createCheckers } from "ts-interface-checker";

interface Column {
  id: string;
}

export interface AddTableParams {
  table_id: string;
  columns: [Column, ...Column[]] | null;
}

export interface RenameTableParams {
  table_id: string;
  new_table_id: string;
}

export interface RemoveTableParams {
  table_id: string;
}

export interface GetTableColumnsParams {
  table_id: string;
}

interface BaseAddColumnOptions {
  label?: string;
  formula?: string;
  description?: string;
  formula_type?: "regular" | "trigger";
  untie_col_id_from_label?: boolean;
  cell_text_color?: string;
  cell_fill_color?: string;
  cell_bold?: boolean;
  cell_underline?: boolean;
  cell_italic?: boolean;
  cell_strikethrough?: boolean;
  header_text_color?: string;
  header_fill_color?: string;
  header_bold?: boolean;
  header_underline?: boolean;
  header_italic?: boolean;
  header_strikethrough?: boolean;
  conditional_formatting_rules?: unknown[];
}

interface AddAnyColumnOptions extends BaseAddColumnOptions {
  type: "Any";
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface AddTextColumnOptions extends BaseAddColumnOptions {
  type: "Text";
  text_format?: "text" | "markdown" | "hyperlink";
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface AddNumericOrIntColumnOptions extends BaseAddColumnOptions {
  number_show_spinner?: boolean;
  number_format?: "text" | "currency" | "decimal" | "percent" | "scientific";
  number_currency_code?: string | null;
  number_minus_sign?: "minus" | "parens";
  number_min_decimals?: number;
  number_max_decimals?: number;
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface AddNumericColumnOptions extends AddNumericOrIntColumnOptions {
  type: "Numeric";
}

interface AddIntColumnOptions extends AddNumericOrIntColumnOptions {
  type: "Int";
}

interface AddBoolColumnOptions extends BaseAddColumnOptions {
  type: "Bool";
  toggle_format?: "text" | "checkbox" | "switch";
}

interface AddDateOrDateTimeColumnOptions extends BaseAddColumnOptions {
  date_format?:
    | "YYYY-MM-DD"
    | "MM-DD-YYYY"
    | "MM/DD/YYYY"
    | "MM-DD-YY"
    | "MM/DD/YY"
    | "DD MMM YYYY"
    | "MMMM Do, YYYY"
    | "DD-MM-YYYY"
    | "custom";
  date_custom_format?: string;
  text_alignment?: "left" | "center" | "right";
}

interface AddDateColumnOptions extends AddDateOrDateTimeColumnOptions {
  type: "Date";
}

interface AddDateTimeColumnOptions extends AddDateOrDateTimeColumnOptions {
  type: "DateTime";
  time_format?:
    | "h:mma"
    | "h:mma z"
    | "HH:mm"
    | "HH:mm z"
    | "HH:mm:ss"
    | "HH:mm:ss z"
    | "custom";
  time_custom_format?: string;
  timezone?: string;
}

interface ChoiceStyle {
  textColor?: string;
  fillColor?: string;
  fontUnderline?: boolean;
  fontItalic?: boolean;
  fontStrikethrough?: boolean;
}

interface AddChoiceOrChoiceListColumnOptions extends BaseAddColumnOptions {
  choices?: string[];
  choice_styles?: { [choice: string]: ChoiceStyle };
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface AddChoiceColumnOptions extends AddChoiceOrChoiceListColumnOptions {
  type: "Choice";
}

interface AddChoiceListColumnOptions
  extends AddChoiceOrChoiceListColumnOptions {
  type: "ChoiceList";
}

interface AddRefOrRefListColumnOptions extends BaseAddColumnOptions {
  reference_table_id: string;
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface AddRefColumnOptions extends AddRefOrRefListColumnOptions {
  type: "Ref";
}

interface AddRefListColumnOptions extends AddRefOrRefListColumnOptions {
  type: "RefList";
}

interface AddAttachmentsColumnOptions extends BaseAddColumnOptions {
  type: "Attachments";
  attachment_height?: number;
}

export type AddTableColumnOptions =
  | AddAnyColumnOptions
  | AddTextColumnOptions
  | AddNumericColumnOptions
  | AddIntColumnOptions
  | AddBoolColumnOptions
  | AddDateColumnOptions
  | AddDateTimeColumnOptions
  | AddChoiceColumnOptions
  | AddChoiceListColumnOptions
  | AddRefColumnOptions
  | AddRefListColumnOptions
  | AddAttachmentsColumnOptions;

export interface AddTableColumnParams {
  table_id: string;
  column_id: string;
  column_options: AddTableColumnOptions;
}

interface BaseUpdateColumnOptions extends BaseAddColumnOptions {
  id?: string;
  formula_recalc_behavior?:
    | "add-record"
    | "add-or-update-record"
    | "custom"
    | "never";
  formula_recalc_col_ids?: string[];
}

type UpdateAnyColumnOptions = AddAnyColumnOptions & BaseUpdateColumnOptions;

type UpdateTextColumnOptions = AddTextColumnOptions & BaseUpdateColumnOptions;

type UpdateNumericColumnOptions = AddNumericColumnOptions &
  BaseUpdateColumnOptions;

type UpdateIntColumnOptions = AddIntColumnOptions & BaseUpdateColumnOptions;

type UpdateBoolColumnOptions = AddBoolColumnOptions & BaseUpdateColumnOptions;

type UpdateDateColumnOptions = AddDateColumnOptions & BaseUpdateColumnOptions;

type UpdateDateTimeColumnOptions = AddDateTimeColumnOptions &
  BaseUpdateColumnOptions;

type UpdateChoiceColumnOptions = AddChoiceColumnOptions &
  BaseUpdateColumnOptions;

type UpdateChoiceListColumnOptions = AddChoiceListColumnOptions &
  BaseUpdateColumnOptions;

interface UpdateRefOrRefListColumnOptions extends BaseUpdateColumnOptions {
  reference_table_id?: string;
  reference_show_column_id?: string;
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
}

interface UpdateRefColumnOptions extends UpdateRefOrRefListColumnOptions {
  type: "Ref";
}

interface UpdateRefListColumnOptions extends UpdateRefOrRefListColumnOptions {
  type: "RefList";
}

type UpdateAttachmentsColumnOptions = AddAttachmentsColumnOptions &
  BaseUpdateColumnOptions;

export type UpdateTableColumnOptions =
  | UpdateAnyColumnOptions
  | UpdateTextColumnOptions
  | UpdateNumericColumnOptions
  | UpdateIntColumnOptions
  | UpdateBoolColumnOptions
  | UpdateDateColumnOptions
  | UpdateDateTimeColumnOptions
  | UpdateChoiceColumnOptions
  | UpdateChoiceListColumnOptions
  | UpdateRefColumnOptions
  | UpdateRefListColumnOptions
  | UpdateAttachmentsColumnOptions;

export interface UpdateTableColumnParams {
  table_id: string;
  column_id: string;
  column_options: UpdateTableColumnOptions;
}

export interface RemoveTableColumnParams {
  table_id: string;
  column_id: string;
}

interface UpdatePageOptions {
  name?: string;
}

export interface UpdatePageParams {
  page_id: number;
  page_options: UpdatePageOptions;
}

export interface RemovePageParams {
  page_id: number;
}

export interface GetPageWidgetsParams {
  page_id: number;
}

interface BaseAddWidgetOptions {
  table_id: string | null;
  group_by_column_ids?: [string, ...string[]];
}

type AddTableWidgetOptions = UpdateTableWidgetOptions & BaseAddWidgetOptions;

type AddCardWidgetOptions = UpdateCardWidgetOptions & BaseAddWidgetOptions;

type AddCardListWidgetOptions = UpdateCardListWidgetOptions &
  BaseAddWidgetOptions;

type AddCustomWidgetOptions = UpdateCustomWidgetOptions & BaseAddWidgetOptions;

type AddWidgetOptions =
  | AddTableWidgetOptions
  | AddCardWidgetOptions
  | AddCardListWidgetOptions
  | AddCustomWidgetOptions;

export interface AddPageWidgetParams {
  page_id: number | null;
  widget_options: AddWidgetOptions;
}

interface BaseUpdateWidgetOptions {
  title?: string;
  description?: string;
}

interface UpdateTableWidgetOptions extends BaseUpdateWidgetOptions {
  type: "table";
}

interface UpdateCardWidgetOptions extends BaseUpdateWidgetOptions {
  type: "card";
}

interface UpdateCardListWidgetOptions extends BaseUpdateWidgetOptions {
  type: "card_list";
}

interface BaseUpdateCustomWidgetOptions extends BaseUpdateWidgetOptions {
  type: "custom";
}

interface UpdateURLCustomWidgetOptions extends BaseUpdateCustomWidgetOptions {
  custom_widget_url: string;
}

interface UpdateRepositoryCustomWidgetOptions
  extends BaseUpdateCustomWidgetOptions {
  custom_widget_id: string;
}

type UpdateCustomWidgetOptions =
  | UpdateURLCustomWidgetOptions
  | UpdateRepositoryCustomWidgetOptions;

type UpdateWidgetOptions =
  | UpdateTableWidgetOptions
  | UpdateCardWidgetOptions
  | UpdateCardListWidgetOptions
  | UpdateCustomWidgetOptions;

export interface UpdatePageWidgetParams {
  widget_id: number;
  widget_options: UpdateWidgetOptions;
}

export interface RemovePageWidgetParams {
  widget_id: number;
}

export interface GetPageWidgetSelectByOptionsParams {
  widget_id: number;
}

interface WidgetSelectBy {
  link_from_widget_id: number;
  link_from_column_id: string | null;
  link_to_column_id: string | null;
}

export interface SetPageWidgetSelectByParams {
  widget_id: number;
  widget_select_by: WidgetSelectBy | null;
}

export interface QueryDocumentParams {
  query: string;
  args: any[] | null;
}

interface Record {
  [colId: string]: CellValue;
}

// TODO: reconcile with GristObjCode and CellValue from `app/plugin/GristData`.
enum GristObjCode {
  List = "L",
  LookUp = "l",
  Dict = "O",
  DateTime = "D",
  Date = "d",
  Skip = "S",
  Censored = "C",
  Reference = "R",
  ReferenceList = "r",
  Exception = "E",
  Pending = "P",
  Unmarshallable = "U",
  Versions = "V",
}

type CellValue =
  | number
  | string
  | boolean
  | null
  | [GristObjCode, ...unknown[]];

export interface AddRecordsParams {
  table_id: string;
  records: [Record, ...Record[]];
}

export interface UpdateRecordsParams {
  table_id: string;
  record_ids: [number, ...number[]];
  records: [Record, ...Record[]];
}

export interface RemoveRecordsParams {
  table_id: string;
  record_ids: [number, ...number[]];
}

const {
  AddTableParams,
  RenameTableParams,
  RemoveTableParams,
  GetTableColumnsParams,
  AddTableColumnParams,
  UpdateTableColumnParams,
  RemoveTableColumnParams,
  UpdatePageParams,
  RemovePageParams,
  GetPageWidgetsParams,
  AddPageWidgetParams,
  UpdatePageWidgetParams,
  RemovePageWidgetParams,
  GetPageWidgetSelectByOptionsParams,
  SetPageWidgetSelectByParams,
  QueryDocumentParams,
  AddRecordsParams,
  UpdateRecordsParams,
  RemoveRecordsParams,
} = createCheckers(OpenAIToolTypesTI);

for (const checker of [
  AddTableParams,
  RenameTableParams,
  RemoveTableParams,
  GetTableColumnsParams,
  AddTableColumnParams,
  UpdateTableColumnParams,
  RemoveTableColumnParams,
  UpdatePageParams,
  RemovePageParams,
  GetPageWidgetsParams,
  AddPageWidgetParams,
  UpdatePageWidgetParams,
  RemovePageWidgetParams,
  GetPageWidgetSelectByOptionsParams,
  SetPageWidgetSelectByParams,
  QueryDocumentParams,
  AddRecordsParams,
  UpdateRecordsParams,
  RemoveRecordsParams,
]) {
  checker.setReportedPath("arguments");
}

export const AddTableParamsChecker = AddTableParams as CheckerT<AddTableParams>;

export const RenameTableParamsChecker =
  RenameTableParams as CheckerT<RenameTableParams>;

export const RemoveTableParamsChecker =
  RemoveTableParams as CheckerT<RemoveTableParams>;

export const GetTableColumnsParamsChecker =
  GetTableColumnsParams as CheckerT<GetTableColumnsParams>;

export const AddTableColumnParamsChecker =
  AddTableColumnParams as CheckerT<AddTableColumnParams>;

export const UpdateTableColumnParamsChecker =
  UpdateTableColumnParams as CheckerT<UpdateTableColumnParams>;

export const RemoveTableColumnParamsChecker =
  RemoveTableColumnParams as CheckerT<RemoveTableColumnParams>;

export const UpdatePageParamsChecker =
  UpdatePageParams as CheckerT<UpdatePageParams>;

export const RemovePageParamsChecker =
  RemovePageParams as CheckerT<RemovePageParams>;

export const GetPageWidgetsParamsChecker =
  GetPageWidgetsParams as CheckerT<GetPageWidgetsParams>;

export const AddPageWidgetParamsChecker =
  AddPageWidgetParams as CheckerT<AddPageWidgetParams>;

export const UpdatePageWidgetParamsChecker =
  UpdatePageWidgetParams as CheckerT<UpdatePageWidgetParams>;

export const RemovePageWidgetParamsChecker =
  RemovePageWidgetParams as CheckerT<RemovePageWidgetParams>;

export const GetPageWidgetSelectByOptionsParamsChecker =
  GetPageWidgetSelectByOptionsParams as CheckerT<GetPageWidgetSelectByOptionsParams>;

export const SetPageWidgetSelectByParamsChecker =
  SetPageWidgetSelectByParams as CheckerT<SetPageWidgetSelectByParams>;

export const QueryDocumentParamsChecker =
  QueryDocumentParams as CheckerT<QueryDocumentParams>;

export const AddRecordsParamsChecker =
  AddRecordsParams as CheckerT<AddRecordsParams>;

export const UpdateRecordsParamsChecker =
  UpdateRecordsParams as CheckerT<UpdateRecordsParams>;

export const RemoveRecordsParamsChecker =
  RemoveRecordsParams as CheckerT<RemoveRecordsParams>;
