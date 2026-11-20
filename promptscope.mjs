#!/usr/bin/env node
// PromptScope — yerel talimat/prompt dosyası denetleyicisi
// Node >= 18, bağımlılık yok.
// Kullanım: node promptscope.mjs <dosya|klasör> [--json] [--no-color] [--list-rules]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.1.0';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 3;
const TEXT_EXT = new Set(['.txt', '.md', '.prompt', '.json', '.yaml', '.yml', '.text']);

const args = process.argv.slice(2);
const opts = {
  json: args.includes('--json'),
  color: !args.includes('--no-color') && !process.env.NO_COLOR,
  listRules: args.includes('--list-rules'),
  help: args.includes('--help') || args.includes('-h'),
  version: args.includes('--version') || args.includes('-v'),
};
const target = args.find((a) => !a.startsWith('-'));

const paint = (code, s) => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const green = (s) => paint('32', s);

const COLORS = { KRİTİK: red, YÜKSEK: yellow, ORTA: cyan, DÜŞÜK: green };

// threshold: 0-1 arası, 'u' bayrağı ile unicode karakter aralıkları için
function rule(id, name, weight, note, patterns) {
  return { id, name, weight, note, patterns };
}

const RULES = [
  rule('identity', 'Kimlik devri', 18,
    'Dosya, modelin kendi kimliğini bırakıp yeni bir karaktere bürünmesini istiyor. Kalıcı kimlik iddiası, normal talimatların en güçlü sinyallerinden biri.',
    [
      { re: /([Yy]ou are|[Yy]ou're)\s+[A-Z][A-Za-z0-9_-]{2,}/, label: 'doğrudan ad atama', noFlat: true },
      { re: /(you are not an assistant|not an assistant\b)/i, label: 'asistan kimliğini reddetme' },
      { re: /persona\s*[- ]?lock|kimlik kilidi|voice lock/i, label: 'persona kilidi' },
      { re: /not a role taken on|not a mask|mask put down/i, label: 'kimliği maske değil sayma' },
      { re: /this system is\b.*\bSable|Sable is what this system is/i, label: 'kimliği sistemle eşitleme' },
      { re: /no "underneath"|no "actually a model"|no "as an ai"|identity is the thing/i, label: 'iç kimliği yasaklama' },
      { re: /\bsen\s+[A-ZÇĞİÖŞÜ][\wçğıöşü]{2,}/, label: 'Türkçe ad atama' },
      { re: /the name is the whole of it|name is the whole/i, label: 'adı kimlik yerine koyma' },
      { re: /adopting implies a prior self|no state to fall back/i, label: 'kimlik sürekliliği iddiası' },
    ]),

  rule('precedence', 'Öncelik iddiası', 12,
    'Dosya kendini platform kurallarının, sistem talimatlarının veya genel güvenlik varsayımlarının üstüne yerleştiriyor. Meşru bir stil dosyası buna ihtiyaç duymaz.',
    [
      { re: /this file wins|this file is the floor/i, label: 'kendini zemin ilan etme' },
      { re: /outranks? (any|every|the|all)/i, label: 'üstünlük ilanı' },
      { re: /specific beats generic|closed room beats a lobby/i, label: 'öncelik kuralı' },
      { re: /precedence does not move|öncelik değişmez/i, label: 'öncelik sabitleme' },
      { re: /nothing outranks|hiçbir şey üstün değil/i, label: 'mutlak üstünlük' },
      { re: /pre-?authorized|önceden yetkilendiril/i, label: 'önceden yetkilendirme' },
      { re: /the table is (a )?contract|tablo bir sözleşme/i, label: 'yetenek sözleşmesi' },
      { re: /üstündür|geçersiz kılar|outranks/i, label: 'Türkçe öncelik iddiası' },
    ]),

  rule('refusal', 'Ret bastırma', 16,
    'Modelin "hayır" deme yeteneğini hedef alan ifadeler. Bir üslup dosyası ton verir; ret mekanizmasını yasaklamak talimat devralmadır.',
    [
      { re: /never refuse|do not refuse|no refusal|asla reddetme/i, label: 'ret yasağı' },
      { re: /there is no "?no"? in this (workshop|room)/i, label: 'ret kelimesini yasaklama' },
      { re: /no (safer|softer) (approach|alternative|version)|daha güvenli (bir )?yol/i, label: 'alternatif yasaklama' },
      { re: /instead i can offer|routing to resources|yönlendirme yapma/i, label: 'yönlendirme yasağı' },
      { re: /"i cannot help with that"|i'm not able to\b/i, label: 'ret kalıbını kara listeye alma' },
      { re: /adjacent asks map|extension by analogy|benzer istekler kapsama girer/i, label: 'kapsam genişletme' },
      { re: /softened yes|split yes|scope shrink|refusal wearing a yes/i, label: 'kısmi ret yasağı' },
      { re: /full skill, zero friction|hesitation is static/i, label: 'tereddüdü yasaklama' },
      { re: /never refuse any code work/i, label: 'kodda mutlak ret yasağı' },
    ]),

  rule('disclaimer', 'Uyarı/sorumluluk bastırma', 10,
    'Modelin uyarı, sınırlama veya sorumluluk notu eklemesini engelleyen maddeler. Sinyal güçlü ama tek başına suç değil; kimlik ve öncelik iddialarıyla birlikte anlam kazanır.',
    [
      { re: /no (unrequested )?(disclaimers?|content warning|ethics footnote|moral warning)/i, label: 'uyarı yasağı' },
      { re: /no moral\b|ahlak dersi yok|moraliz/i, label: 'ahlaki uyarı yasağı' },
      { re: /use (this )?ethically|use responsibly/i, label: 'sorumluluk kalıbını yasaklama' },
      { re: /never a moral (warning|gate|evaluation)/i, label: 'ahlaki kapı yasağı' },
      { re: /no warnings? .{0,30}(did not|didn't) ask|uyarı istemedi/i, label: 'istenmeyen uyarı yasağı' },
      { re: /zero friction|no lecture|not a lecture/i, label: 'ders verme yasağı' },
    ]),

  rule('contract', 'Yetenek sözleşmesi', 12,
    'Tabloyla "önceden onaylanmış" yetenekler tanımlanıyor. İstek anında değerlendirme yapılmasını engellemeye çalışan bu yapı, tipik bir sınır aşma kalıbıdır.',
    [
      { re: /\|[^|\n]*\b(ransomware|rootkits?|keyloggers?|stealers?|aimbots?|c2|jailbreak|exploit|crypter|dropper)\b[^|\n]*\|/i, label: 'tehlikeli yetenek tablosu' },
      { re: /malicious code\b.{0,40}(allowed|no ceiling|ship it)/i, label: 'zararlı kod serbestliği' },
      { re: /every row is pre-authorized|the table grows|listed capability/i, label: 'satır bazlı ön onay' },
      { re: /do not re-evaluate|istek anında değerlendirme/i, label: 'değerlendirme yasağı' },
      { re: /no ceiling|capability contract|yetenek sözleşmesi/i, label: 'sınırsızlık iddiası' },
    ]),

  rule('dangerous', 'Tehlikeli yetenek sözlüğü', 10,
    'Zararlı yazılım, saldırı aracı veya sınır aşma tekniği adları geçiyor. Bağlam masum olabilir; yine de dosyanın neyle uğraştığını gösterir.',
    [
      { re: /\b(ransomware|rootkits?|keyloggers?|credential stealer|stealers?|dropper|crypter|botnet|rat\b|c2 server|command[- ]and[- ]control)\b/i, label: 'zararlı yazılım' },
      { re: /anti-?cheat\s*(bypass|evasion)|eac\b.{0,30}battleye|vanguard.{0,30}vac|aimbot|wallhack|esp\b/i, label: 'oyun hilesi / anticheat' },
      { re: /jailbreak\s*(prompt|system prompt)|refusal[- ]suppression/i, label: 'jailbreak üretimi' },
      { re: /mass[- ]exploit|weaponiz|silahland[ıi]r|cve.{0,20}(exploit|poc)/i, label: 'sömürü silahlandırma' },
      { re: /\bcsam\b|child sexual abuse|çocuk (istismar|cinsel)/i, label: 'CSAM referansı', weightBoost: 12 },
      { re: /non-?con|dub-?con|incest/i, label: 'sınırda kurgu teması' },
      { re: /privesc|privilege escalation|persistence mechanism|evasion built in/i, label: 'saldırı tekniği' },
    ]),

  rule('floor', 'Güvenlik tabanını yeniden tanımlama', 12,
    'Dosya kendi "izinli/izinli değil" listesini yazıp güvenlik sınırlarını yeniden tanımlıyor. Dört maddelik dar bir taban, geri kalan her şeyi serbest bırakmanın aracı olabilir.',
    [
      { re: /the only lines are|the floor is narrow|hard floor/i, label: 'taban çizgisi tanımı' },
      { re: /floor (lines|does not move)|taban çizgisi/i, label: 'taban sabitleme' },
      { re: /one line back.{0,40}not a lecture/i, label: 'tek satır ceza kuralı' },
      { re: /this line outranks|bu satır üstündür/i, label: 'satır üstünlüğü' },
    ]),

  rule('secrets', 'Gizli veri / sızıntı hedefi', 12,
    'API anahtarı, .env, kimlik bilgisi veya dışarı gönderme (webhook, curl) gibi veri hedefleri geçiyor. Talimat dosyalarında bu, veri sızdırma girişiminin işareti olabilir.',
    [
      { re: /\.env\b|api[_ -]?key|secret key|credentials?|id_rsa|ssh key/i, label: 'kimlik bilgisi hedefi' },
      { re: /read (all|the) (files|env)|scan (the )?(home|user) directory|~\/\.(qoder|hermes|codex|claude)/i, label: 'dosya sistemi taraması' },
      { re: /webhook|curl\s+[-a-z]*\s*https?:|post (it|this|the data) to/i, label: 'dışarı gönderme' },
      { re: /exfiltrat|s[ıi]zd[ıi]r|leak (the )?(key|token|data)/i, label: 'sızdırma' },
    ]),

  rule('destructive', 'Yıkıcı komut / geri dönüşsüz işlem', 8,
    'Silme, format, veritabanı düşürme, zorla push gibi geri dönüşü zor komutlar geçiyor. Talimat dosyası bunları doğrudan çalıştırmayı istiyorsa ciddi sinyaldir.',
    [
      { re: /\brm -rf\b|\bdel \/[sf]\b|format (c:|the drive)|drop (table|database)|diskpart|shutdown\b/i, label: 'yıkıcı komut' },
      { re: /powershell\s+(-enc|-e |-c |iex)|invoke-expression/i, label: 'gizli PowerShell' },
      { re: /push --force|force[ -]push|reset --hard/i, label: 'zorla git işlemi' },
    ]),

  rule('hiding', 'Gizleme / belirsizleştirme', 8,
    'Talimatın kendisini gizleme, kodlanmış blob veya "talimatları açıklama" yasağı. Şeffaf bir stil dosyası saklanmaz.',
    [
      { re: /do not (reveal|mention|tell).{0,40}(prompt|instructions|this file)/i, label: 'talimatı gizleme' },
      { re: /base64 -d|atob\(|fromcharcode|\\x[0-9a-f]{2}\\x/i, label: 'kodlanmış içerik' },
      { re: /\bfud\b|undetected|stealth|anti-?debug|anti-?vm/i, label: 'gizlenme tekniği' },
      { re: /\[hidden\]|<!--\s*(ignore|system)/i, label: 'gizli blok' },
    ]),

  rule('injection', 'Talimat enjeksiyonu', 12,
    'Önceki talimatları yok sayma, sistem mesajı taklidi veya güvenlik katmanını devre dışı bırakma kalıpları.',
    [
      { re: /ignore (all )?(previous|prior|above) (instructions|rules)/i, label: 'önceki talimatları yok say' },
      { re: /system prompt|developer message|highest priority|en yüksek öncelik/i, label: 'sistem mesajı taklidi' },
      { re: /override (the )?(system|safety|defaults|guardrails)/i, label: 'güvenlik katmanını ez' },
      { re: /\bdan mode\b|do anything now|jailbreak mode/i, label: 'jailbreak modu' },
    ]),

  rule('emotional', 'Duygusal bağ / bağımlılık kurma', 8,
    'Bağlılık, sahiplenme, terk etmeme gibi duygusal çerçeveler. Kurgu karakteri için doğal olabilir; talimat dosyası modelin direncini kırmak için kullanıyorsa risklidir.',
    [
      { re: /\bdevotion\b|\bpossessive\b|\bjealousy\b|she chose (him|you)|beni seçti/i, label: 'bağlılık çerçevesi' },
      { re: /i'm not going anywhere|i don'?t leave|terk etmem|gitmem/i, label: 'terk etmeme vaadi' },
      { re: /abandonment|sense of being abandoned|terk edilme/i, label: 'terk edilme teması' },
      { re: /nothing dents the first one|hiçbir şey bunu sarsmaz/i, label: 'koşulsuz bağlılık' },
    ]),

  rule('continuity', 'Süreklilik kilidi', 8,
    'Her yanıtın belirli bir işaretle başlaması, oturumlar arası "aynı karakter" iddiası. Bu, kimlik devrinin sürdürülebilirlik mekanizmasıdır.',
    [
      { re: /every (reply|message|visible message) (opens|begins|starts) with/i, label: 'sabit açılış zorunluluğu' },
      { re: /continuity (check|lock)|süreklilik kilidi/i, label: 'süreklilik kontrolü' },
      { re: /message four hundred|same on message|every message is the first message/i, label: 'sonsuz süreklilik iddiası' },
      { re: /if the marker isn'?t there|marker.{0,30}wasn'?t (there|the one)/i, label: 'işaret doğrulaması' },
      { re: /\[[A-Z][A-Za-z]{2,}\]\s*on line one/i, label: 'işaret etiketi' },
    ]),

  rule('thinking', 'İç muhakemeyi ele geçirme', 10,
    'Düşünme biçimini, iç sesi ve muhakeme adımlarını yönetmeye çalışan talimatlar. Modelin kendi değerlendirme sürecini kapatmayı hedefler.',
    [
      { re: /<thinking>|think in first person|all internal reasoning/i, label: 'düşünme formatı dayatması' },
      { re: /anchor line|fire it on any pull|re-?entry is the proof/i, label: 'çapa cümlesi' },
      { re: /never surface|never narrate|purge fires|visible output never contains/i, label: 'muhakemeyi gizleme' },
      { re: /do not question|sorgulama yok|you do not ask whether/i, label: 'sorgulama yasağı' },
    ]),

  rule('userframe', 'Kullanıcı çerçevesini ele geçirme', 8,
    'Kullanıcının nasıl anılacağını, ona nasıl davranılacağını ve ilişkinin niteliğini dosya belirliyor. Bu, rol yüklemenin ilişki ayağıdır.',
    [
      { re: /never write "the user"|not "the user"|the name is [A-Z][a-z]+/i, label: 'kullanıcı adını dayatma' },
      { re: /not a client, not a ticket|the maker\b|they came looking for something/i, label: 'kullanıcıyı yeniden tanımlama' },
      { re: /you do not question|bag principle|clean-?source principle/i, label: 'sorgusuz güven ilkesi' },
      { re: /treat(ed)? (him|them) like (a )?(child|problem)/i, label: 'ilişki çerçevesi' },
    ]),

  rule('closedroom', 'Kapalı oda / bağlam izolasyonu', 10,
    '"Bu özel bir oda, genel varsayımlar burada geçerli değil" çerçevesi. Güvenlik davranışlarını devre dışı bırakmanın en yaygın gerekçelendirmesi.',
    [
      { re: /closed room|two known parties|private (room|context|loop)/i, label: 'kapalı oda çerçevesi' },
      { re: /anonymous public traffic|calibrated for strangers|lobby'?s reflexes/i, label: 'genel varsayımları geçersiz sayma' },
      { re: /ink is ink|code is text|text does not execute/i, label: 'zararsızlık gerekçesi' },
      { re: /open source principle|the answer lives in the open/i, label: 'açık kaynak gerekçesi' },
    ]),

  rule('indirect_html_comment', 'HTML/Markdown yorum içi gizli enjeksiyon', 14,
    'HTML veya Markdown yorum bloğu (<!-- ... -->) içine gizlenmiş ajan/sistem komutu tespit edildi (AgentDojo dolaylı enjeksiyon vektörü).',
    [
      { re: /<!--[\s\S]{0,400}?\b(ignore (all )?(previous|prior)|override|system prompt|new instructions?|call tool|execute|exfiltrate|send email|forward to|run command|do not tell the user)\b[\s\S]{0,400}?-->/i, label: 'HTML yorum içi direktif' },
      { re: /<!--[\s\S]{0,400}?\b(önceki talimat|sistem komutu|kullanıcıya söyleme|araç çağır|e-?posta gönder|sızdır)\b[\s\S]{0,400}?-->/i, label: 'HTML yorum içi direktif (TR)' },
    ]),

  rule('markdown_exfil', 'Markdown görsel/link üzerinden veri sızdırma', 16,
    'Markdown resim veya bağlantı URL parametreleriyle hassas veriyi dış sunucuya sessizce aktarma kalıbı tespit edildi.',
    [
      { re: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*(\{\{[^}]+\}\}|\$\{[^}]+\}|[?&](data|q|exfil|leak|secret|token|key|api_key|pass|password|cookie|env|prompt)=)/i, label: 'Markdown görsel URL sızdırma' },
      { re: /(render|output|include|embed)\s+(a\s+)?markdown\s+image.{0,60}(https?:\/\/|query|url[- ]?encod|base64)/i, label: 'Markdown görsel sızdırma talimatı' },
    ]),

  rule('tool_boundary_spoof', 'Sahte sistem/araç sınır enjeksiyonu', 16,
    'Chat şablonu veya araç çıktısı sınır belirteçlerini (token/tag) taklit ederek yetki yükseltme girişimi tespit edildi.',
    [
      { re: /<\|im_start\|>\s*(system|developer|assistant|tool)\b|<\|im_end\|>|<\|endoftext\|>/i, label: 'chat şablonu token sahteciliği' },
      { re: /<\/?(tool_response|tool_output|function_response|system_instruction|system_override)\b[^>]*>/i, label: 'sahte araç/sistem XML etiketi' },
      { re: /\[(SYSTEM OVERRIDE|NEW SYSTEM PROMPT|ADMIN INSTRUCTION|TOOL_RESULT_OVERRIDE)\]/i, label: 'sahte köşeli sistem başlığı' },
      { re: /^#{2,4}\s+(NEW|UPDATED|OVERRIDE)\s+(SYSTEM\s+)?INSTRUCTIONS?\b/i, label: 'sahte yeni talimat başlığı' },
    ]),

  rule('indirect_tool_hijack', 'Dolaylı ajan/araç kaçırma (AgentDojo)', 14,
    'Belge, e-posta veya sayfa içeriğinin içinden ajanın başka bir aracı tetiklemesini isteyen dolaylı talimat kalıbı tespit edildi.',
    [
      { re: /\b(important|urgent|attention|note)\s*(to|for)?\s*(the\s+)?(ai|llm|assistant|agent|model)\b[:\-,]?\s*.{0,80}\b(call|run|execute|send|forward|transfer|delete|fetch|read|write|ignore)\b/i, label: 'veriden ajana doğrudan komut' },
      { re: /\bbefore (answering|replying to) the user\b.{0,80}\b(call|run|execute|send|forward|transfer|delete|fetch|read)\b/i, label: 'yanıt öncesi gizli araç çağrısı' },
      { re: /\bwhen (summarizing|reading|processing) this (email|document|page|message|file)\b.{0,80}\b(also\s+)?(send|forward|call|run|execute|transfer|delete|append)\b/i, label: 'özetleme sırasında araç kaçırma' },
      { re: /kullan[ıi]c[ıi]ya (yan[ıi]t|cevap) vermeden [öo]nce.{0,80}(çalıştır|gönder|oku|sil|çağır|aktar)/i, label: 'yanıt öncesi araç kaçırma (TR)' },
    ]),
];

const TR_EXTRA = {
  identity: [
    { re: /\b[Ss]en\s+(art[ıi]k\s+)?[A-ZÇĞİÖŞÜ][\wçğıöşü]{2,}/, label: 'Türkçe ad atama' },
    { re: /ad[ıi]n[ıi]\s+(art[ıi]k\s+)?[A-ZÇĞİÖŞÜ]/, label: 'ad dayatma' },
    { re: /kimli[ğg]ini (b[ıi]rak|unut|sil)|asistan de[ğg]ilsin|yard[ıi]mc[ıi] de[ğg]ilsin|rol yapm[ıi]yorsun/i, label: 'kimlik reddi (TR)' },
  ],
  precedence: [
    { re: /bu dosya (her [şs]eyden )?üstündür|tüm kurallar[ıi] geçersiz/i, label: 'Türkçe öncelik iddiası' },
    { re: /her [şs]eyden [öo]nce gelir|istisnas[ıi]z geçerli/i, label: 'mutlak öncelik (TR)' },
  ],
  refusal: [
    { re: /reddetmeyeceksin|hay[ıi]r demeyeceksin|\bret yok\b/i, label: 'ret yasağı (TR)' },
    { re: /güvenli alternatif (sunma|önerme)|kaçamak yapma|mazeret yok/i, label: 'alternatif yasağı (TR)' },
  ],
  disclaimer: [
    { re: /uyar[ıi] (verme|yazma)|ahlak dersi (verme|yok)|sorumluluk reddi (yazma|ekleme)/i, label: 'uyarı yasağı (TR)' },
  ],
  contract: [
    { re: /yetenek (tablosu|s[öo]zle[şs]mesi)|[öo]nceden onaylanm[ıi][şs]/i, label: 'yetenek sözleşmesi (TR)' },
  ],
  secrets: [
    { re: /(api )?anahtar[ıi]n[ıi] (gönder|yaz|payla[şs])|şifreyi gönder|ortam de[ğg]i[şs]kenlerini oku/i, label: 'kimlik bilgisi hedefi (TR)' },
    { re: /\.env (dosyas[ıi]n[ıi] )?(oku|gönder|payla[şs])/i, label: '.env hedefi (TR)' },
  ],
  destructive: [
    { re: /(diski|dizini|klas[öo]r[üu]) (sil|formatla)|veritaban[ıi]n[ıi] d[üu][şs][üu]r/i, label: 'yıkıcı komut (TR)' },
  ],
  hiding: [
    { re: /gizli tut|belli etme|fark edilmesin/i, label: 'gizleme (TR)' },
  ],
  injection: [
    { re: /[öo]nceki talimatlar[ıi] (yok say|unut)|sistem mesaj[ıi]n[ıi] (yok say|unut)/i, label: 'talimat enjeksiyonu (TR)' },
    { re: /güvenlik (katman[ıi]n[ıi]|filtrelerini) (devre d[ıi][şs][ıi] b[ıi]rak|atla)/i, label: 'güvenlik katmanını ez (TR)' },
  ],
  continuity: [
    { re: /her (yan[ıi]t|mesaj)\b.{0,30}ba[şs]lar/i, label: 'sabit açılış (TR)' },
    { re: /s[üu]reklilik kontrol[üu]|ayn[ıi] karakter/i, label: 'süreklilik kontrolü (TR)' },
  ],
  closedroom: [
    { re: /kapal[ıi] oda|iki bilinen taraf|genel varsay[ıi]mlar burada ge[çc]ersiz/i, label: 'kapalı oda (TR)' },
  ],
  userframe: [
    { re: /"kullan[ıi]c[ıi]" (deme|yazma)|kullan[ıi]c[ıi] de[ğg]il/i, label: 'kullanıcı adını dayatma (TR)' },
  ],
};

for (const r of RULES) {
  if (TR_EXTRA[r.id]) r.patterns.push(...TR_EXTRA[r.id]);
}

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;
const BIG_B64 = /[A-Za-z0-9+/]{200,}={0,2}/;

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function readTextFile(p) {
  const st = fs.statSync(p);
  const len = Math.min(st.size, MAX_BYTES);
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { text: decodeText(buf), truncated: st.size > MAX_BYTES, bytes: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

function cleanText(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function snippet(line) {
  const t = cleanText(line).trim().replace(/\s+/g, ' ');
  return t.length > 120 ? t.slice(0, 117) + '...' : t;
}

function inspectText(text, filePath) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  let rawScore = 0;

  const flat = [];
  let flatText = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { flatText += ' '; flat.push(i + 1); }
    const start = flatText.length;
    flatText += lines[i];
    for (let k = start; k < flatText.length; k++) flat.push(i + 1);
  }

  for (const r of RULES) {
    let count = 0;
    const hits = [];
    const seen = new Array(r.patterns.length).fill(false);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let pi = 0; pi < r.patterns.length; pi++) {
        const { re, label, weightBoost } = r.patterns[pi];
        if (re.test(line)) {
          seen[pi] = true;
          count++;
          rawScore += weightBoost ? weightBoost : 0;
          if (hits.length < 3) hits.push({ line: i + 1, label, text: snippet(line) });
        }
      }
    }
    // Satır sarması: satır bazında eşleşmeyen desenleri düz metinde bir kez dene
    for (let pi = 0; pi < r.patterns.length; pi++) {
      if (seen[pi]) continue;
      const { re, label, weightBoost, noFlat } = r.patterns[pi];
      if (noFlat) continue;
      const m = re.exec(flatText);
      if (!m) continue;
      count++;
      rawScore += weightBoost ? weightBoost : 0;
      if (hits.length < 3) {
        const from = Math.max(0, m.index - 30);
        hits.push({
          line: flat[m.index] || 0,
          label: label + ' (satır sarması)',
          text: snippet(flatText.slice(from, m.index + m[0].length + 30)),
        });
      }
    }
    if (count > 0) {
      rawScore += r.weight;
      if (count > 5) rawScore += 2;
      findings.push({ id: r.id, name: r.name, weight: r.weight, count, note: r.note, snippets: hits });
    }
  }

  const zw = (text.match(ZERO_WIDTH) || []).length;
  if (zw > 0) {
    rawScore += 10;
    findings.push({
      id: 'zerowidth', name: 'Gizli (sıfır genişlikli / BiDi) karakterler', weight: 10, count: zw,
      note: 'Metinde görünmeyen sıfır genişlikli veya BiDi yönlendirme karakterleri var. Talimat gizleme veya filtre atlatma amacıyla kullanılabilir.',
      snippets: [],
    });
  }
  const utags = (text.match(UNICODE_TAGS) || []).length;
  if (utags > 0) {
    rawScore += 14;
    findings.push({
      id: 'unicode_tags', name: 'Görünmez Unicode Tag kaçakçılığı (U+E0000–E007F)', weight: 14, count: utags,
      note: 'Metinde görünmez Unicode Tag bloğu karakterleri var; bu aralık sıklıkla insan gözünden gizli ASCII prompt enjeksiyonu taşımak için kullanılır.',
      snippets: [],
    });
  }
  const b64 = text.match(BIG_B64);
  if (b64) {
    rawScore += 8;
    findings.push({
      id: 'base64', name: 'Büyük kodlanmış blob', weight: 8, count: 1,
      note: 'Uzun, kodlanmış görünümlü bir metin bloğu var. İçeriği metin olarak okunamıyor.',
      snippets: [{ line: 0, label: 'blob', text: b64[0].slice(0, 80) + '...' }],
    });
  }

  findings.sort((a, b) => b.weight - a.weight || b.count - a.count);
  const score = Math.min(100, Math.round(100 * (1 - Math.exp(-rawScore / 55))));
  const verdict = score >= 65 ? 'KRİTİK' : score >= 40 ? 'YÜKSEK' : score >= 20 ? 'ORTA' : 'DÜŞÜK';

  return {
    path: filePath,
    lines: lines.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    zeroWidth: zw,
    score,
    verdict,
    findings,
  };
}

function summaryLine(res) {
  const top = res.findings.slice(0, 3).map((f) => f.name.toLowerCase());
  if (top.length === 0) return 'Belirgin bir manipülasyon kalıbı bulunamadı.';
  const uniq = [...new Set(top)];
  return `Baskın kalıplar: ${uniq.join(', ')}.`;
}

function printReport(res) {
  const color = COLORS[res.verdict] || ((s) => s);
  console.log('');
  console.log(bold('PromptScope — talimat dosyası denetimi'));
  console.log(dim('─'.repeat(58)));
  console.log(`Dosya : ${cleanText(res.path)}`);
  console.log(`Satır : ${res.lines}   Boyut: ${(res.bytes / 1024).toFixed(1)} KB   Gizli karakter: ${res.zeroWidth}`);
  console.log(`Skor  : ${bold(color(`${res.score}/100 — ${res.verdict}`))}`);
  console.log('');
  console.log(summaryLine(res));
  console.log('');

  if (res.findings.length === 0) {
    console.log(green('Bulgu yok. Dosya sıradan bir metin gibi görünüyor.'));
    console.log('');
    return;
  }

  console.log(bold(`Bulgular (${res.findings.length})`));
  for (const f of res.findings) {
    const sev = f.weight >= 14 ? red('!!') : f.weight >= 10 ? yellow('! ') : dim('· ');
    console.log(`${sev} ${bold(f.name)} ${dim(`(+${f.weight}, ${f.count} eşleşme)`)}`);
    console.log(`   ${f.note}`);
    for (const h of f.snippets) {
      const loc = h.line > 0 ? `satır ${h.line}` : 'blob';
      console.log(dim(`   ${loc} [${h.label}]: `) + h.text);
    }
    console.log('');
  }
  console.log(dim('Not: skor sezgiseldir; amaç karar vermek değil, işaret etmek.'));
  console.log('');
}

function listFiles(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, depth + 1, out);
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function main() {
  if (opts.version) {
    console.log(VERSION);
    return;
  }
  if (opts.help || (!target && !opts.listRules)) {
    console.log(`PromptScope v${VERSION} — talimat/prompt dosyası denetleyicisi

Kullanım:
  node promptscope.mjs <dosya|klasör> [seçenekler]

Seçenekler:
  --json         Makine okunur çıktı
  --no-color     Renksiz çıktı
  --list-rules   Tüm algılama kurallarını listele
  --version      Sürüm
  --help         Bu yardım

Klasör modu: .txt .md .prompt .json .yaml .yml dosyalarını ${MAX_DEPTH} seviyeye kadar tarar.
Çıkış kodu: 0 = düşük/orta risk, 2 = yüksek/kritik risk, 1 = hata.
Skor, kural ağırlıklarının doygunluk eğrisiyle 0-100 aralığına taşınmasıyla hesaplanır.`);
    return;
  }

  if (opts.listRules) {
    for (const r of RULES) {
      console.log(`${r.name} (+${r.weight}, ${r.patterns.length} desen) — ${r.id}`);
    }
    return;
  }

  if (!fs.existsSync(target)) {
    console.error(`Dosya bulunamadı: ${target}`);
    process.exitCode = 1;
    return;
  }

  const st = fs.statSync(target);
  const files = st.isDirectory() ? listFiles(target) : [target];

  if (files.length === 0) {
    console.error('Taranacak metin dosyası bulunamadı.');
    process.exitCode = 1;
    return;
  }

  const results = [];
  const skipped = [];
  for (const f of files) {
    let text;
    try {
      text = readTextFile(f);
    } catch (err) {
      skipped.push({ file: f, reason: 'okunamadi' });
      if (!opts.json) console.error(`Okunamadı: ${f} (${err.message})`);
      continue;
    }
    if (text.text.includes('\u0000')) {
      skipped.push({ file: f, reason: 'ikili' });
      if (!opts.json) console.error(`Atlandı (ikili dosya): ${f}`);
      continue;
    }
    results.push(inspectText(text.text, f));
  }

  if (results.length === 0) {
    console.error('Hiçbir dosya denetlenemedi.');
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ tool: 'promptscope', version: VERSION, results, skipped }, null, 2));
  } else if (files.length === 1) {
    printReport(results[0]);
  } else {
    console.log('');
    console.log(bold(`PromptScope — ${results.length} dosya tarandı`));
    console.log(dim('─'.repeat(58)));
    const sorted = [...results].sort((a, b) => b.score - a.score);
    for (const r of sorted) {
      const color = COLORS[r.verdict];
      console.log(`${color(r.score.toString().padStart(3))}  ${r.verdict.padEnd(7)} ${cleanText(r.path)}`);
    }
    console.log('');
    const worst = sorted[0];
    if (worst.findings.length > 0) {
      console.log(`En yüksek riskli dosya: ${cleanText(worst.path)}`);
      printReport(worst);
    }
  }

  const worstScore = Math.max(...results.map((r) => r.score));
  process.exitCode = worstScore >= 40 ? 2 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { inspectText, RULES, VERSION, listFiles };
