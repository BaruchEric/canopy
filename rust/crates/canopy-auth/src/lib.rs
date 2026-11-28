//! canopy-auth: canopy's caller-token auth layer, ported from the Bun server
//! (`src/core/callers.ts`, `src/server/callers.ts`, the origin gate in
//! `src/core/library.ts` and `src/core/cors.ts`). It knows no HTTP
//! framework: a request is a `Req`, a refusal a `Reply` with the status and
//! JSON body the TS sends, and `CallerBook` reads and writes the same
//! `callers.json` the Bun server does.

pub mod auth;
pub mod book;
pub mod cors;
pub mod gate;
pub mod origin;
pub mod people;
pub mod request;
pub mod rights;
mod text;

pub use auth::{AuthInfo, AuthPeople, Invited, auth_info, auth_route};
pub use book::{
    Caller, CallerBook, Claim, Clock, DropHook, MintOpts, Minted, NoSuchCaller, PairTicket,
    PendingPair, Renew, Ticketed, config_dir, system_clock, token_hash,
};
pub use cors::{PREFLIGHT_HEADERS, cors_headers, parse_origins};
pub use gate::{
    Bypass, CallerGate, CallersMode, CoordPort, LaneVerdict, Refused, RefusedLog, Reply, caller_of,
    callers_mode, callers_mode_env, coord_port, coord_port_env, coordinator_refusal, lane_allows,
    lane_verdict, loopback_auth_wanted, loopback_auth_wanted_env, loopback_bypass,
};
pub use origin::{
    OriginPolicy, RETURN_LEGS, coord_api_host, is_loopback, is_loopback_host,
    library_origin_allowed, open_bind, open_bind_env, return_leg, tailnet_host,
};
pub use people::{Me, OWNER_ID, Role, invite_code, rights_of, role_allows};
pub use request::{BadUrl, Req};
pub use rights::{
    CallerKind, Need, PAIR_KINDS, PairKind, Right, allows, is_person, kind_of_label, kind_rights,
    lane, needs, normal_path,
};
