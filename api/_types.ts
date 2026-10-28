/** Request/response shapes shared by the API functions and the client (type-only imports). */

/** One ordered quantity: item id (normalized model|color), labels for humans, size label, quantity. */
export interface OrderLine {
  id: string;
  model: string;
  color: string;
  size: string;
  qty: number;
}

export interface RoundState {
  locked: boolean;
  archived: boolean;
}

export interface RoundDto extends RoundState {
  id: string;
  name: string;
  createdTime: string;
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
  | { action: 'login'; round: string; name: string; pin: string; create?: boolean }
  | { action: 'load' }
  | { action: 'save'; lines: OrderLine[]; baseRev: number }
  | { action: 'submit'; lines: OrderLine[]; baseRev: number };

export interface OrderResponse {
  order: OrderDto;
  round: RoundState;
  /** Only on login: the session token for `Authorization: Bearer`. */
  token?: string;
  /** Only on login: true when this login created the order or set a new PIN after a reset. */
  pinSet?: boolean;
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
  hasPin: boolean;
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
  | { action: 'resetPin'; round: string; fileId: string };
