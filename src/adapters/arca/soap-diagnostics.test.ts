import { describe, expect, it, vi } from "vitest";
import { redactSoap, createHomologacionCapture } from "./soap-diagnostics";
import { WSAA_HOMOLOGACION_URL } from "./constants";

describe("bounded XML diagnostics", () => {
  it("removes protected elements/attributes across namespace and case, PEM and reflected secrets", () => {
    const token = 'secret<&"value';
    const xml = `<s:Envelope xmlns:s="urn:s"><s:Body><AUTH privateKEY="private"><Token>x</Token><Sign>y</Sign></AUTH><credentials>x</credentials><in0>cms</in0><loginCmsReturn>ticket</loginCmsReturn><Result ns:ToKeN="leak" other="secret&lt;&amp;&quot;value"><!--secret--><Err><Code>602</Code><Msg>Exact message secret&lt;&amp;"value</Msg></Err><faultstring>-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----</faultstring></Result></s:Body></s:Envelope>`;
    const redacted = redactSoap(xml, [token]);
    expect(redacted).toContain("602");
    expect(redacted).toContain("Exact message");
    for (const secret of ["private", "ticket", "cms", "leak", "secret", "abc"]) expect(redacted).not.toContain(secret);
  });
  it.each(["not xml", "<x>", '<!DOCTYPE x [<!ENTITY a "secret">]><x>&a;</x>', "<x>" + "x".repeat(1048576) + "</x>"])("omits malformed/unsafe input without raw fallback", xml => {
    expect(redactSoap(xml, [])).toBe("[SOAP omitted: unsafe XML]");
  });
  it("redacts escaped and double-escaped reflected values, comments and CDATA", () => {
    const result = redactSoap('<x note="s&amp;amp;v"><![CDATA[s&v]]><!--s&v--><Msg>s&amp;v / s&amp;amp;v</Msg><Sign Value="hidden"/></x>', ["s&v"]);
    expect(result).not.toContain("s&v"); expect(result).not.toContain("s&amp;"); expect(result).not.toContain("hidden");
  });
  it("requires explicit homo opt-in, never captures auth responses or off-allowlist hosts", () => {
    const write = vi.fn();
    for (const environment of ["production", "homologacion"]) {
      const capture = createHomologacionCapture({ environment, enabled: false, secrets: () => [], write });
      capture("response", "https://wswhomo.afip.gov.ar/wsfev1/service.asmx", "<x/>");
    }
    const capture = createHomologacionCapture({ environment: "homologacion", enabled: true, secrets: () => [], write });
    capture("response", "https://wsaahomo.afip.gov.ar/ws/services/LoginCms", "<x/>");
    capture("response", "https://evil.test", "<x/>"); expect(write).not.toHaveBeenCalled();
    capture("response", "https://wswhomo.afip.gov.ar/wsfev1/service.asmx", "<x><Err><Code>602</Code><Msg>Exact</Msg></Err></x>");
    expect(write).toHaveBeenCalledOnce(); expect(write.mock.calls[0]![0]).toContain("Exact");
  });
});

it("removes a reflected CMS discovered from the in-memory authentication request",()=> {
 const writes:string[]=[];const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>[],write:x=>writes.push(x)});
 capture("request","https://wsaahomo.afip.gov.ar/ws/services/LoginCms","<Envelope><in0>FAKE_CMS_SECRET</in0></Envelope>");
 capture("response","https://wswhomo.afip.gov.ar/wsfev1/service.asmx","<Envelope><faultstring>invalid FAKE_CMS_SECRET</faultstring></Envelope>");
 expect(writes.join("")).not.toContain("FAKE_CMS_SECRET");
});

describe("WSAA fault-only homologacion diagnostics", () => {
 const fault = (code:string,message:string,extra="") => `<s:Envelope xmlns:s="urn:soap"><s:Body><s:Fault><faultcode>${code}</faultcode><faultstring>${message}</faultstring>${extra}</s:Fault></s:Body></s:Envelope>`;
 it("prints only bounded fault fields and safe HTTP metadata, never raw WSAA XML/details", () => {
  const write=vi.fn();const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>[],write});
  capture("response",WSAA_HOMOLOGACION_URL,fault("ns1:coe.alreadyAuthenticated","El CEE ya posee un TA valido","<detail><loginCmsReturn>UNEXPECTED_TICKET</loginCmsReturn><other>PRIVATE_DETAIL</other></detail>"),{httpStatus:500,mediaType:"text/xml",shape:"xml"});
  expect(write).toHaveBeenCalledOnce();const output=write.mock.calls[0]![0];
  expect(output).toContain('"faultcode":"ns1:coe.alreadyAuthenticated"');expect(output).toContain('"faultstring":"El CEE ya posee un TA valido"');expect(output).toContain('"httpStatus":500');
  for(const secret of ["<s:Envelope","UNEXPECTED_TICKET","PRIVATE_DETAIL","loginCmsReturn"])expect(output).not.toContain(secret);
 });
 it("redacts known secret and CMS reflections as well as unknown PEM/base64/credential assignments", () => {
  const writes:string[]=[];const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>["KNOWN_KEY"],write:x=>writes.push(x)});
  capture("request",WSAA_HOMOLOGACION_URL,"<Envelope><in0>KNOWN_CMS</in0></Envelope>");
  capture("response",WSAA_HOMOLOGACION_URL,fault("ns1:error","invalid KNOWN_KEY KNOWN_CMS Token=UNKNOWN_TOKEN Sign: UNKNOWN_SIGN "+"A".repeat(96)+" -----BEGIN PRIVATE KEY-----PEM_VALUE-----END PRIVATE KEY-----"));
  const output=writes.join("");for(const value of ["KNOWN_KEY","KNOWN_CMS","UNKNOWN_TOKEN","UNKNOWN_SIGN","A".repeat(96),"PEM_VALUE"])expect(output).not.toContain(value);
  expect(output).toContain("faultcode");expect(output).toContain("REDACTED");
 });
 it("redacts known wrapped PEM bodies including their short final line",()=>{
  const tail="SHORTTAIL12==",line="Q".repeat(64),body=`${line}\n${tail}`;
  const pem=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  const write=vi.fn();const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>[pem],write});
  capture("response",WSAA_HOMOLOGACION_URL,fault("ns1:error",`invalid material ${body}`));
  expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0]![0]).not.toContain(tail);expect(write.mock.calls[0]![0]).not.toContain(line);
 });
 it("omits a credential-like fault field rewrapped differently rather than leaking its tail",()=>{
  const body="Q".repeat(64)+"R".repeat(64)+"TAIL1234==";
  const pem=`-----BEGIN PRIVATE KEY-----\n${body.slice(0,64)}\n${body.slice(64,128)}\n${body.slice(128)}\n-----END PRIVATE KEY-----`;
  const reflected=`${body.slice(0,72)}\n${body.slice(72)}`;
  const write=vi.fn();const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>[pem],write});
  capture("response",WSAA_HOMOLOGACION_URL,fault("ns1:error",`invalid material ${reflected}`));
  expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0]![0]).not.toContain("R".repeat(16));expect(write.mock.calls[0]![0]).not.toContain("TAIL1234");
 });
 it.each(["faultcode","faultstring"] as const)("redacts URI/base64/base64url encodings of short known secrets in %s",field=>{
  const secret="a+b/c?",base64=Buffer.from(secret).toString("base64");
  const variants=[encodeURIComponent(secret),encodeURIComponent(secret).replace(/%[0-9a-f]{2}/gi,x=>x.toLowerCase()),base64,base64.replace(/=+$/,""),Buffer.from(secret).toString("base64url")];
  for(const encoded of variants){
   const write=vi.fn();const capture=createHomologacionCapture({environment:"homologacion",enabled:true,secrets:()=>[secret],write});
   capture("response",WSAA_HOMOLOGACION_URL,fault(field==="faultcode"?encoded:"ns1:error",field==="faultstring"?encoded:"El CEE ya posee un TA valido"));
   expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0]![0]).not.toContain(encoded);
  }
 });
 it("suppresses successful, malformed, oversized, DTD/entity, off-host, production and non-opted WSAA responses", () => {
  const write=vi.fn();
  for(const [environment,enabled] of [["homologacion",true],["production",true],["homologacion",false]] as const){
   const capture=createHomologacionCapture({environment,enabled,secrets:()=>[],write});
   if(environment!=="homologacion"||!enabled)capture("response",WSAA_HOMOLOGACION_URL,fault("ns1:error","message"));
   for(const xml of ["<Envelope><loginCmsReturn>SECRET_TICKET</loginCmsReturn></Envelope>","<Envelope>","<!DOCTYPE x><Envelope/>",fault("x","A".repeat(1048576))])capture("response",WSAA_HOMOLOGACION_URL,xml);
   capture("response","https://evil.test",fault("x","message"));
  }
  expect(write).not.toHaveBeenCalled();
 });
});
