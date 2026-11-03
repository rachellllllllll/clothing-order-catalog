/** Request/response shapes shared by the API functions and the client (type-only imports). */

/** One ordered quantity: item id (normalized model|color), labels for humans, size label, quantity. */
export interface OrderLine {
  id: string;
  model: string;
  color: string;
  size: string;
  qty: number;
}

/** Units of one order line (item id + size) that did not arrive from the supplier, marked by the admin. */
export interface ShortageLine {
  id: string;
  size: string;
  qty: number;
}

/** Order file id -> the units of that order that did not arrive. */
export type Shortages = Record<string, ShortageLine[]>;

/** Sets how many units of one orderer's line did not arrive (qty 0 clears the mark). */
export interface ShortageChange extends ShortageLine {
  fileId: string;
}

export interface RoundState {
  locked: boolean;
  archived: boolean;
}

export interface RoundDto extends RoundState {
  id: string;
  name: string;
  createdTime: string;
  /** Created on the admin page (catalog stored as JSON): its catalog can be edited there. */
  editable?: boolean;
  /** Still being prepared: hidden from orderers (admin only). */
  draft?: boolean;
}

/** Image URLs (small for cards, large for the lightbox). */
export interface ImageUrls {
  thumb: string;
  full: string;
}

/** A color of a product; the id stays the same when the color is renamed (orders refer to it). */
export interface DocColor {
  id: string;
  /** Empty for a product without colors. */
  name: string;
}

/** A product (model) of a catalog edited on the admin page. Each color is one orderable item. */
export interface DocProduct {
  id: string;
  model: string;
  price: number | null;
  notes: string;
  /** The round sizes this product comes in. */
  sizes: string[];
  /** At least one (a single color with an empty name = no colors). */
  colors: DocColor[];
  /** Drive file id of the product image (in the round folder). */
  image: string | null;
}

/** catalog.json of a round created on the admin page. Item id = `<product id>.<color id>`. */
export interface CatalogDoc {
  v: 1;
  /** The round's size columns, in display order. */
  sizes: string[];
  products: DocProduct[];
}

/** GET /api/catalog (and the admin `catalog` action) for a round created on the admin page. */
export interface DocCatalogResponse {
  round: { id: string; name: string };
  catalog: CatalogDoc;
  /** Image file id -> URLs, for the images the catalog uses. */
  images: Record<string, ImageUrls>;
  /** Admin only: the stored revision, sent back with `saveCatalog`. */
  rev?: number;
}

export interface SubmittedDto {
  at: string;
  rev: number;
  lines: OrderLine[];
}

/** An orderer's order as the orderer (and the admin) sees it. */
export interface OrderDto {
  name: string;
  /** Bumped on every save; the client sends it back as `baseRev` to detect edits from another device. */
  rev: number;
  createdAt: string;
  updatedAt: string;
  lines: OrderLine[];
  submitted: SubmittedDto | null;
}

/** POST /api/order */
export type OrderRequest =
  | { action: 'signin'; name: string; pin: string }
  | { action: 'linkSignin'; key: string }
  | { action: 'open'; round: string }
  | { action: 'login'; round: string; name: string; pin: string }
  | { action: 'load' }
  | { action: 'save'; lines: OrderLine[]; baseRev: number }
  | { action: 'submit'; lines: OrderLine[]; baseRev: number };

/** `signin` / `linkSignin`: the token opens the member's order in any round (`open`). */
export interface SigninResponse {
  name: string;
  token: string;
}

export interface OrderResponse {
  order: OrderDto;
  round: RoundState;
  /** Only on open/login: the session token of this round's order for `Authorization: Bearer`. */
  token?: string;
  /** Only on open/login: true when this opened the orderer's order in this round. */
  created?: boolean;
  /** On open/login/load of a locked or archived round: units of this order that did not arrive. */
  shortages?: ShortageLine[];
}

/** Admin list row (read from Drive file properties, without downloading the order). */
export interface OrderSummary {
  fileId: string;
  name: string;
  rev: number;
  units: number;
  updatedAt: string;
  submittedAt: string | null;
  submittedRev: number | null;
}

/** A person on the orderers list (only they can sign in). The code itself is never returned, only when issued. */
export interface MemberDto {
  id: string;
  name: string;
  phone: string;
  email: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** A newly issued sign-in code (shown to the admin once), with the member's personal sign-in link key. */
export interface IssuedCode {
  member: MemberDto;
  code: string;
  link: string;
}

export interface NewMember {
  name: string;
  phone?: string;
  email?: string;
}

/** POST /api/admin */
export type AdminRequest =
  | { action: 'login'; password: string }
  | { action: 'logout' }
  | { action: 'session' }
  | { action: 'orders'; round: string }
  | { action: 'order'; round: string; fileId: string }
  | { action: 'allOrders'; round: string }
  | { action: 'setRound'; round: string; locked?: boolean; archived?: boolean }
  | { action: 'setShortages'; round: string; changes: ShortageChange[] }
  | { action: 'rounds' }
  | { action: 'createRound'; name: string; sizes: string[] }
  | { action: 'catalog'; round: string }
  | { action: 'saveCatalog'; round: string; catalog: CatalogDoc; rev: number; name?: string }
  | { action: 'uploadImage'; round: string; data: string }
  | { action: 'publishRound'; round: string }
  | { action: 'deleteRound'; round: string }
  | { action: 'members' }
  | { action: 'addMembers'; members: NewMember[] }
  | { action: 'updateMember'; id: string; name?: string; phone?: string; email?: string; active?: boolean }
  | { action: 'newCode'; id: string }
  | { action: 'loginLinks'; ids: string[] }
  | { action: 'deleteMember'; id: string }
  | { action: 'pastOrderers' };
