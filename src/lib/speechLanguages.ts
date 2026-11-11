/** Every language the speech model (Whisper) understands, by code, with a readable name; sorted by name. */
const CODES =
  "af,am,ar,as,az,ba,be,bg,bn,bo,br,bs,ca,cs,cy,da,de,el,en,es,et,eu,fa,fi,fo,fr,gl,gu,ha,haw,he,hi,hr,ht,hu,hy,id,is,it,ja,jw,ka,kk,km,kn,ko,la,lb,ln,lo,lt,lv,mg,mi,mk,ml,mn,mr,ms,mt,my,ne,nl,nn,no,oc,pa,pl,ps,pt,ro,ru,sa,sd,si,sk,sl,sn,so,sq,sr,su,sv,sw,ta,te,tg,th,tk,tl,tr,tt,uk,ur,uz,vi,yi,yo,yue,zh".split(
    ",",
  );

// codes the browser's language names do not know as Whisper writes them
const ALIAS: Record<string, string> = { jw: "jv", haw: "haw", yue: "yue" };

function nameOf(code: string): string {
  try {
    const n = new Intl.DisplayNames(["en"], { type: "language" }).of(ALIAS[code] ?? code);
    if (n && n.toLowerCase() !== code) return n;
  } catch {
    /* an older engine without Intl.DisplayNames: the code stands in */
  }
  return code.toUpperCase();
}

export const SPEECH_LANGUAGES: { code: string; name: string }[] = CODES.map((code) => ({ code, name: nameOf(code) })).sort((a, b) =>
  a.name.localeCompare(b.name),
);

export const speechLanguageName = (code: string) => SPEECH_LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
