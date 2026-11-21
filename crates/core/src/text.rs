//! Text in any encoding — subtitles, playlists, plain text, code and CSV shown by the apps.
//!
//! The order is the one browsers use for local files: a byte-order mark (UTF-8, UTF-16LE,
//! UTF-16BE) wins; then text that is valid UTF-8 (or plain ASCII) is UTF-8; then UTF-16
//! without a mark (every other byte a NUL); else Firefox's detector (`chardetng`) guesses
//! a legacy encoding — Windows-1251 Russian, Shift_JIS Japanese, GBK, Big5, EUC-KR,
//! Windows-1253/1254/1255/1256 … — helped by a language hint (the `ru` of `Movie.ru.srt`,
//! or the system locale), and `encoding_rs` decodes. A guess the detector is not sure of
//! comes back with `confident: false`, so the apps can offer their Encoding menu.

use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub text: String,
    /// the WHATWG name of what was used: "UTF-8", "UTF-16LE", "windows-1251", "Shift_JIS"…
    pub encoding: String,
    /// false when the detector guessed and could be wrong (or bytes did not fit)
    pub confident: bool,
}

/// Decode a whole file's bytes.
pub fn decode(bytes: &[u8], hint: Option<&str>) -> Decoded {
    decode_prefix(bytes, hint, true)
}

/// Decode `bytes`; `complete` is false when they are only the start of a longer file (the
/// first 2 MB): a character cut in half at the end is dropped instead of becoming `�`.
pub fn decode_prefix(bytes: &[u8], hint: Option<&str>, complete: bool) -> Decoded {
    let (encoding, bom, confident) = detect(bytes, hint, complete);
    let (text, errors) = run(encoding, &bytes[bom..], complete);
    Decoded {
        text,
        encoding: encoding.name().to_string(),
        confident: confident && !errors,
    }
}

/// Decode as the encoding the person chose (any WHATWG label: "windows-1251", "sjis",
/// "gbk", "utf-16le"…); a byte-order mark of that same encoding is skipped. `None` for a
/// label nobody knows.
pub fn decode_as(bytes: &[u8], label: &str, complete: bool) -> Option<Decoded> {
    let encoding = Encoding::for_label(label.trim().as_bytes())?;
    let bom = match Encoding::for_bom(bytes) {
        Some((found, len)) if found == encoding => len,
        _ => 0,
    };
    let (text, _) = run(encoding, &bytes[bom..], complete);
    Some(Decoded {
        text,
        encoding: encoding.name().to_string(),
        confident: true,
    })
}

/// `label` when given and known, else detection.
pub fn decode_with(
    bytes: &[u8],
    label: Option<&str>,
    hint: Option<&str>,
    complete: bool,
) -> Decoded {
    label
        .filter(|l| !l.trim().is_empty() && !l.eq_ignore_ascii_case("auto"))
        .and_then(|l| decode_as(bytes, l, complete))
        .unwrap_or_else(|| decode_prefix(bytes, hint, complete))
}

/// Which encoding `bytes` are in: the encoding, how many leading bytes are its BOM, and
/// whether that is certain rather than a guess.
pub fn detect(
    bytes: &[u8],
    hint: Option<&str>,
    complete: bool,
) -> (&'static Encoding, usize, bool) {
    if let Some((encoding, len)) = Encoding::for_bom(bytes) {
        return (encoding, len, true);
    }
    if is_utf8(bytes, complete) {
        return (UTF_8, 0, true);
    }
    if let Some(encoding) = utf16_without_bom(bytes) {
        return (encoding, 0, true);
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, complete);
    let tld = hint.and_then(tld_for);
    let hinted = detector.guess(tld.map(str::as_bytes), chardetng::Utf8Detection::Allow);
    let generic = detector.guess(None, chardetng::Utf8Detection::Allow);
    // the hint swayed it: a reasonable guess, but one worth a second look
    (hinted, 0, hinted == generic)
}

/// Valid UTF-8; a prefix may end inside a character.
fn is_utf8(bytes: &[u8], complete: bool) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => !complete && e.error_len().is_none() && bytes.len() - e.valid_up_to() < 4,
    }
}

/// UTF-16 without a byte-order mark: Latin text has a NUL in every other byte.
fn utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    let pairs = sample.len() / 2;
    if pairs < 4 {
        return None;
    }
    let (mut first, mut second) = (0usize, 0usize);
    for pair in sample.as_chunks::<2>().0 {
        first += usize::from(pair[0] == 0);
        second += usize::from(pair[1] == 0);
    }
    // "a\0b\0" is little-endian; at least 40 % NULs on one side, nearly none on the other
    if second * 10 >= pairs * 4 && first * 20 <= pairs {
        Some(UTF_16LE)
    } else if first * 10 >= pairs * 4 && second * 20 <= pairs {
        Some(UTF_16BE)
    } else {
        None
    }
}

fn run(encoding: &'static Encoding, bytes: &[u8], last: bool) -> (String, bool) {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len().saturating_mul(3));
    let mut out = String::with_capacity(capacity);
    let (_, _, errors) = decoder.decode_to_string(bytes, &mut out, last);
    (out, errors)
}

/// The language the system runs in (`LC_ALL`, `LC_CTYPE`, `LANG`, then `LANGUAGE`), as a
/// hint for [`decode`]: `ru_RU.UTF-8` → `ru_RU.UTF-8` (mapped by [`tld_for`]).
pub fn locale_hint() -> Option<String> {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    std::env::var("LANGUAGE")
        .ok()
        .and_then(|v| v.split(':').next().map(str::to_string))
        .filter(|v| !v.is_empty())
}

/// A language or locale (`ru`, `rus`, `ja_JP.UTF-8`, `zh-TW`, `pt_BR`) → the top-level
/// domain chardetng weighs its guess with. English, `C` and unknown codes → `None` (no
/// preference: the detector's own Western-leaning default).
pub fn tld_for(hint: &str) -> Option<&'static str> {
    let base = hint.split(['.', '@']).next()?.to_ascii_lowercase();
    let mut parts = base.split(['_', '-']);
    let lang = parts.next()?;
    let region = parts.next();
    if matches!(lang, "zh" | "chi" | "zho" | "chs" | "cht") {
        return Some(match (lang, region) {
            ("cht", _) | (_, Some("tw" | "hant" | "mo")) => "tw",
            (_, Some("hk")) => "hk",
            _ => "cn",
        });
    }
    let tld = match lang {
        "ru" | "rus" => "ru",
        "uk" | "ukr" => "ua",
        "be" | "bel" => "by",
        "bg" | "bul" => "bg",
        "sr" | "srp" | "scc" => "rs",
        "mk" | "mkd" | "mac" => "mk",
        "kk" | "kaz" => "kz",
        "ar" | "ara" => "sa",
        "fa" | "fas" | "per" => "ir",
        "ur" | "urd" => "pk",
        "el" | "ell" | "gre" => "gr",
        "he" | "heb" | "iw" | "yi" | "yid" => "il",
        "tr" | "tur" => "tr",
        "az" | "aze" => "az",
        "ja" | "jpn" | "jp" => "jp",
        "ko" | "kor" => "kr",
        "th" | "tha" => "th",
        "vi" | "vie" => "vn",
        "pl" | "pol" => "pl",
        "cs" | "ces" | "cze" => "cz",
        "sk" | "slk" | "slo" => "sk",
        "hu" | "hun" => "hu",
        "sl" | "slv" => "si",
        "hr" | "hrv" => "hr",
        "ro" | "ron" | "rum" => "ro",
        "lt" | "lit" => "lt",
        "lv" | "lav" => "lv",
        "is" | "isl" | "ice" => "is",
        "fr" | "fra" | "fre" => "fr",
        "de" | "deu" | "ger" => "de",
        "es" | "spa" => "es",
        "it" | "ita" => "it",
        "pt" | "por" => "pt",
        "nl" | "nld" | "dut" => "nl",
        "sv" | "swe" => "se",
        "da" | "dan" => "dk",
        "no" | "nor" | "nb" | "nob" | "nn" | "nno" => "no",
        "fi" | "fin" => "fi",
        _ => return None,
    };
    Some(tld)
}

/// The language tag in a file name, read from the end: `Movie.ru.srt` → `ru`,
/// `Movie.rus.forced.ass` → `rus`, `Film_zh-TW.srt` → `zh-TW`. Only codes [`tld_for`]
/// knows count.
pub fn language_in_name(name: &str) -> Option<String> {
    let stem = match name.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => name,
    };
    let tokens: Vec<&str> = stem.split(['.', '_', ' ', '[', ']', '(', ')']).collect();
    for token in tokens.iter().rev().skip_while(|t| t.is_empty()).take(4) {
        let lower = token.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "forced" | "sdh" | "cc" | "hi" | "default" | "full"
        ) {
            continue;
        }
        // "zh-TW", "pt-BR"
        if (2..=7).contains(&lower.len()) && tld_for(&lower).is_some() {
            return Some((*token).to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same five-line subtitle, written by Python's codecs (not encoding_rs) in each
    /// encoding: `tests/fixtures/text/<lang>.<encoding>.srt` next to `<lang>.utf8.srt`.
    macro_rules! fixture {
        ($name:literal) => {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/text/",
                $name
            ))
            .as_slice()
        };
    }

    fn utf8(bytes: &[u8]) -> &str {
        std::str::from_utf8(bytes).unwrap()
    }

    /// (file, its UTF-8 original, encodings the decoder may name)
    fn cases() -> Vec<(
        &'static str,
        &'static [u8],
        &'static str,
        &'static [&'static str],
    )> {
        vec![
            (
                "ru.cp1251.srt",
                fixture!("ru.cp1251.srt"),
                utf8(fixture!("ru.utf8.srt")),
                &["windows-1251"],
            ),
            (
                "ar.cp1256.srt",
                fixture!("ar.cp1256.srt"),
                utf8(fixture!("ar.utf8.srt")),
                &["windows-1256"],
            ),
            (
                "el.cp1253.srt",
                fixture!("el.cp1253.srt"),
                utf8(fixture!("el.utf8.srt")),
                &["windows-1253", "ISO-8859-7"],
            ),
            (
                "he.cp1255.srt",
                fixture!("he.cp1255.srt"),
                utf8(fixture!("he.utf8.srt")),
                &["windows-1255"],
            ),
            (
                "tr.cp1254.srt",
                fixture!("tr.cp1254.srt"),
                utf8(fixture!("tr.utf8.srt")),
                &["windows-1254"],
            ),
            (
                "zh.gbk.srt",
                fixture!("zh.gbk.srt"),
                utf8(fixture!("zh.utf8.srt")),
                &["GBK", "gb18030"],
            ),
            (
                "zh.gb18030.srt",
                fixture!("zh.gb18030.srt"),
                utf8(fixture!("zh.utf8.srt")),
                &["GBK", "gb18030"],
            ),
            (
                "zh-TW.big5.srt",
                fixture!("zh-TW.big5.srt"),
                utf8(fixture!("zh-TW.utf8.srt")),
                &["Big5"],
            ),
            (
                "ja.shift_jis.srt",
                fixture!("ja.shift_jis.srt"),
                utf8(fixture!("ja.utf8.srt")),
                &["Shift_JIS"],
            ),
            (
                "ko.euc-kr.srt",
                fixture!("ko.euc-kr.srt"),
                utf8(fixture!("ko.utf8.srt")),
                &["EUC-KR"],
            ),
            (
                "fr.latin1.srt",
                fixture!("fr.latin1.srt"),
                utf8(fixture!("fr.utf8.srt")),
                &["windows-1252"],
            ),
            (
                "ru.utf16le-bom.srt",
                fixture!("ru.utf16le-bom.srt"),
                utf8(fixture!("ru.utf8.srt")),
                &["UTF-16LE"],
            ),
            (
                "ja.utf16be-bom.srt",
                fixture!("ja.utf16be-bom.srt"),
                utf8(fixture!("ja.utf8.srt")),
                &["UTF-16BE"],
            ),
            (
                "ar.utf8-bom.srt",
                fixture!("ar.utf8-bom.srt"),
                utf8(fixture!("ar.utf8.srt")),
                &["UTF-8"],
            ),
            (
                "ka.utf8.srt",
                fixture!("ka.utf8.srt"),
                utf8(fixture!("ka.utf8.srt")),
                &["UTF-8"],
            ),
            (
                "fr.utf16le.srt",
                fixture!("fr.utf16le.srt"),
                utf8(fixture!("fr.utf8.srt")),
                &["UTF-16LE"],
            ),
        ]
    }

    #[test]
    fn every_encoding_reads_right_without_a_hint() {
        for (name, bytes, want, encodings) in cases() {
            let got = decode(bytes, None);
            assert_eq!(got.text, want, "{name} decoded as {}", got.encoding);
            assert!(
                encodings.contains(&got.encoding.as_str()),
                "{name}: {}",
                got.encoding
            );
        }
    }

    #[test]
    fn every_encoding_reads_right_with_its_file_name_hint() {
        for (name, bytes, want, encodings) in cases() {
            let hint = language_in_name(name);
            let got = decode(bytes, hint.as_deref());
            assert_eq!(got.text, want, "{name} (hint {hint:?}) as {}", got.encoding);
            assert!(
                encodings.contains(&got.encoding.as_str()),
                "{name}: {}",
                got.encoding
            );
        }
    }

    #[test]
    fn a_wrong_locale_hint_does_not_turn_text_into_mojibake() {
        // a Russian file opened on a Japanese system, a Japanese one on a Russian system
        let ru = decode(fixture!("ru.cp1251.srt"), Some("ja_JP.UTF-8"));
        assert_eq!(ru.text, utf8(fixture!("ru.utf8.srt")), "{}", ru.encoding);
        let ja = decode(fixture!("ja.shift_jis.srt"), Some("ru_RU.UTF-8"));
        assert_eq!(ja.text, utf8(fixture!("ja.utf8.srt")), "{}", ja.encoding);
        // French Latin-1 is not Turkish, Cyrillic or Greek, whatever the system says
        for hint in [
            None,
            Some("tr_TR.UTF-8"),
            Some("ru_RU.UTF-8"),
            Some("el_GR.UTF-8"),
            Some("en_US.UTF-8"),
        ] {
            let fr = decode(fixture!("fr.latin1.srt"), hint);
            assert_eq!(
                fr.text,
                utf8(fixture!("fr.utf8.srt")),
                "{hint:?} → {}",
                fr.encoding
            );
        }
    }

    #[test]
    fn certainty() {
        assert!(decode(fixture!("ka.utf8.srt"), None).confident);
        assert!(decode(fixture!("ru.utf16le-bom.srt"), None).confident);
        assert!(decode(b"plain ascii", None).confident);
        assert_eq!(decode(b"plain ascii", None).encoding, "UTF-8");
        // a few bytes of anything: decoded, but not sure
        let short = decode(b"caf\xE9", Some("ru"));
        assert!(!short.confident || short.text == "café");
    }

    #[test]
    fn a_prefix_cut_inside_a_character_loses_only_that_character() {
        let ja = fixture!("ja.utf8.srt");
        // cut one byte into a three-byte character
        let cut = ja.iter().rposition(|b| *b >= 0xE0).unwrap() + 1;
        let got = decode_prefix(&ja[..cut], None, false);
        assert_eq!(got.encoding, "UTF-8");
        assert!(!got.text.contains('\u{FFFD}'));
        assert!(utf8(ja).starts_with(&got.text));
        let sjis = fixture!("ja.shift_jis.srt");
        let cut = sjis.iter().rposition(|b| *b >= 0x81).unwrap() + 1;
        let got = decode_prefix(&sjis[..cut], None, false);
        assert_eq!(got.encoding, "Shift_JIS");
        assert!(!got.text.contains('\u{FFFD}'), "{}", got.text);
    }

    #[test]
    fn the_person_can_override_the_guess() {
        let ru = fixture!("ru.cp1251.srt");
        let koi = decode_as(ru, "koi8-r", true).unwrap();
        assert_eq!(koi.encoding, "KOI8-R");
        assert_ne!(koi.text, utf8(fixture!("ru.utf8.srt")));
        let back = decode_with(ru, Some("windows-1251"), None, true);
        assert_eq!(back.text, utf8(fixture!("ru.utf8.srt")));
        assert_eq!(
            decode_with(ru, Some("auto"), None, true).encoding,
            "windows-1251"
        );
        assert!(decode_as(ru, "no-such-encoding", true).is_none());
        // a BOM of the chosen encoding is not part of the text
        let le = decode_as(fixture!("ru.utf16le-bom.srt"), "utf-16le", true).unwrap();
        assert_eq!(le.text, utf8(fixture!("ru.utf8.srt")));
    }

    #[test]
    fn hints() {
        assert_eq!(tld_for("ru_RU.UTF-8"), Some("ru"));
        assert_eq!(tld_for("rus"), Some("ru"));
        assert_eq!(tld_for("zh_TW.UTF-8"), Some("tw"));
        assert_eq!(tld_for("zh-HK"), Some("hk"));
        assert_eq!(tld_for("zh_CN"), Some("cn"));
        assert_eq!(tld_for("ja"), Some("jp"));
        assert_eq!(tld_for("en_US.UTF-8"), None);
        assert_eq!(tld_for("C"), None);
        assert_eq!(language_in_name("Movie.ru.srt").as_deref(), Some("ru"));
        assert_eq!(
            language_in_name("Movie.2019.rus.forced.ass").as_deref(),
            Some("rus")
        );
        assert_eq!(language_in_name("Film_zh-TW.srt").as_deref(), Some("zh-TW"));
        assert_eq!(language_in_name("Movie.srt"), None);
        assert_eq!(language_in_name("The.Office.S01E01.srt"), None);
    }
}
