/**
 * Shared ARCA adapter constants — service names, endpoints, cache keys.
 *
 * WSAA/WSFE retain their AFIP hosts; Padrón v4.1 publishes ARCA hosts.
 * Production and homologación (`wswhomo`/`awshomo`) hosts are distinct;
 * `ARCA_ENV` selects between them at runtime.
 */

/** ARCA service name for WSFEv1 (invoice emission). */
export const ARCA_SERVICE_WSFE = "wsfe";

/** ARCA service name for Padrón A5 (constancia de inscripción). */
export const ARCA_SERVICE_PADRON = "ws_sr_constancia_inscripcion";

/** WSAA (authentication) endpoints. */
export const WSAA_PRODUCTION_URL =
  "https://wsaa.afip.gov.ar/ws/services/LoginCms";
export const WSAA_HOMOLOGACION_URL =
  "https://wsaahomo.afip.gov.ar/ws/services/LoginCms";

/** WSFEv1 (emission) SOAP endpoints. */
export const WSFE_PRODUCTION_URL =
  "https://servicios1.afip.gov.ar/wsfev1/service.asmx";
export const WSFE_HOMOLOGACION_URL =
  "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

/** Padrón constancia v4.1 §2.5; confirmed against each public WSDL soap:address.
 * https://www.afip.gob.ar/ws/WSCI/manual_ws_sr_ws_constancia_inscripcion.pdf
 */
export const PADRON_PRODUCTION_URL =
  "https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5";
export const PADRON_HOMOLOGACION_URL =
  "https://awshomo.arca.gob.ar/sr-padron/webservices/personaServiceA5";

/** Selects the `production` or `homologacion` endpoint set. */
export type ArcaEnvironment = "production" | "homologacion";
