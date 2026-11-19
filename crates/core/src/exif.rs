//! EXIF for the picture info panels (ewe Viewer, ewe Files' properties): the few tags
//! people look for, read with kamadak-exif from JPEG, TIFF, HEIF, PNG and WebP.
//! Values come back plain (`exposure` as "1/250", `f_number` as 1.8) and the webview
//! turns them into words.

use std::io::BufReader;
use std::path::Path;

use exif::{In, Tag, Value};
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    /// `DateTimeOriginal` (else `DateTime`) as "YYYY-MM-DD HH:MM:SS"
    pub date: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// e.g. "1/250" or "2" (seconds)
    pub exposure: Option<String>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    pub focal_length: Option<f64>,
    pub focal_length_35mm: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// the EXIF orientation 1–8 (1 = as stored)
    pub orientation: Option<u32>,
    pub software: Option<String>,
    /// decimal degrees, north/east positive
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

impl ExifInfo {
    pub fn is_empty(&self) -> bool {
        *self == ExifInfo::default()
    }
}

/// Read a file's EXIF; `None` when the file has none (or cannot be opened).
pub fn read(path: &Path) -> Option<ExifInfo> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let data = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let info = from_exif(&data);
    if info.is_empty() { None } else { Some(info) }
}

/// Parse a raw Exif/TIFF blob (what `read_raw` takes) — for tests and callers that
/// already have the bytes.
pub fn from_raw(raw: Vec<u8>) -> Option<ExifInfo> {
    let data = exif::Reader::new().read_raw(raw).ok()?;
    let info = from_exif(&data);
    if info.is_empty() { None } else { Some(info) }
}

fn text(data: &exif::Exif, tag: Tag) -> Option<String> {
    let field = data.get_field(tag, In::PRIMARY)?;
    let s = match &field.value {
        Value::Ascii(parts) => parts
            .iter()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect::<Vec<_>>()
            .join(" "),
        _ => field.display_value().to_string(),
    };
    let s = s.trim().trim_matches('\0').trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn uint(data: &exif::Exif, tag: Tag) -> Option<u32> {
    data.get_field(tag, In::PRIMARY)?.value.get_uint(0)
}

fn rational(data: &exif::Exif, tag: Tag) -> Option<f64> {
    match &data.get_field(tag, In::PRIMARY)?.value {
        Value::Rational(v) => v.first().map(|r| r.to_f64()),
        Value::SRational(v) => v.first().map(|r| r.to_f64()),
        other => other.get_uint(0).map(f64::from),
    }
}

/// "1/250" for fractions of a second, "2" / "2.5" for whole and half seconds.
pub fn format_exposure(seconds: f64) -> Option<String> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    if seconds >= 1.0 {
        let s = if seconds.fract() == 0.0 {
            format!("{seconds:.0}")
        } else {
            format!("{seconds:.1}")
        };
        return Some(s);
    }
    Some(format!("1/{:.0}", (1.0 / seconds).round()))
}

fn exposure(data: &exif::Exif) -> Option<String> {
    format_exposure(rational(data, Tag::ExposureTime)?)
}

fn date(data: &exif::Exif) -> Option<String> {
    let raw = text(data, Tag::DateTimeOriginal).or_else(|| text(data, Tag::DateTime))?;
    // EXIF: "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD HH:MM:SS"
    let mut chars: Vec<char> = raw.chars().collect();
    if chars.len() >= 10 && chars[4] == ':' && chars[7] == ':' {
        chars[4] = '-';
        chars[7] = '-';
    }
    let s: String = chars.into_iter().collect();
    if s.starts_with("0000") { None } else { Some(s) }
}

fn coordinate(data: &exif::Exif, value: Tag, reference: Tag) -> Option<f64> {
    let field = data.get_field(value, In::PRIMARY)?;
    let Value::Rational(parts) = &field.value else {
        return None;
    };
    if parts.len() < 3 {
        return None;
    }
    let deg = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    let sign = match text(data, reference).as_deref() {
        Some("S") | Some("W") => -1.0,
        _ => 1.0,
    };
    Some(sign * deg)
}

fn from_exif(data: &exif::Exif) -> ExifInfo {
    ExifInfo {
        date: date(data),
        make: text(data, Tag::Make),
        model: text(data, Tag::Model),
        lens: text(data, Tag::LensModel),
        exposure: exposure(data),
        f_number: rational(data, Tag::FNumber),
        iso: uint(data, Tag::PhotographicSensitivity),
        focal_length: rational(data, Tag::FocalLength),
        focal_length_35mm: uint(data, Tag::FocalLengthIn35mmFilm),
        width: uint(data, Tag::PixelXDimension).or_else(|| uint(data, Tag::ImageWidth)),
        height: uint(data, Tag::PixelYDimension).or_else(|| uint(data, Tag::ImageLength)),
        orientation: uint(data, Tag::Orientation),
        software: text(data, Tag::Software),
        latitude: coordinate(data, Tag::GPSLatitude, Tag::GPSLatitudeRef),
        longitude: coordinate(data, Tag::GPSLongitude, Tag::GPSLongitudeRef),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialise one IFD whose out-of-line data starts at `data_start`; returns the IFD
    /// bytes (with a zero next-IFD pointer) and the data blob.
    fn ifd(entries: &[(u16, Entry)], data_start: u32) -> (Vec<u8>, Vec<u8>) {
        let mut data_start = data_start;
        let mut ifd = Vec::new();
        let mut blob = Vec::new();
        ifd.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, entry) in entries {
            ifd.extend_from_slice(&tag.to_le_bytes());
            match entry {
                Entry::Ascii(s) => {
                    let mut bytes = s.as_bytes().to_vec();
                    bytes.push(0);
                    ifd.extend_from_slice(&2u16.to_le_bytes());
                    ifd.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                    if bytes.len() <= 4 {
                        let mut v = [0u8; 4];
                        v[..bytes.len()].copy_from_slice(&bytes);
                        ifd.extend_from_slice(&v);
                    } else {
                        ifd.extend_from_slice(&data_start.to_le_bytes());
                        blob.extend_from_slice(&bytes);
                        data_start += bytes.len() as u32;
                    }
                }
                Entry::Short(v) => {
                    ifd.extend_from_slice(&3u16.to_le_bytes());
                    ifd.extend_from_slice(&1u32.to_le_bytes());
                    ifd.extend_from_slice(&v.to_le_bytes());
                    ifd.extend_from_slice(&[0, 0]);
                }
                Entry::Long(v) => {
                    ifd.extend_from_slice(&4u16.to_le_bytes());
                    ifd.extend_from_slice(&1u32.to_le_bytes());
                    ifd.extend_from_slice(&v.to_le_bytes());
                }
                Entry::Rational(num, den) => {
                    ifd.extend_from_slice(&5u16.to_le_bytes());
                    ifd.extend_from_slice(&1u32.to_le_bytes());
                    ifd.extend_from_slice(&data_start.to_le_bytes());
                    blob.extend_from_slice(&num.to_le_bytes());
                    blob.extend_from_slice(&den.to_le_bytes());
                    data_start += 8;
                }
            }
        }
        ifd.extend_from_slice(&0u32.to_le_bytes());
        (ifd, blob)
    }

    /// A little-endian TIFF: IFD0 with the TIFF tags plus an Exif IFD pointer, then the
    /// Exif IFD (where ExposureTime & co. live), each followed by its data.
    fn tiff(tiff_tags: &[(u16, Entry)], exif_tags: &[(u16, Entry)]) -> Vec<u8> {
        let ifd0_len = 2 + (tiff_tags.len() as u32 + 1) * 12 + 4;
        let ifd0_data = 8 + ifd0_len;
        // the pointer needs the Exif IFD offset, which needs IFD0's data size: two passes
        let (_, blob0) = ifd(tiff_tags, ifd0_data);
        let exif_start = ifd0_data + blob0.len() as u32;
        let mut tags0: Vec<(u16, Entry)> = Vec::new();
        for (t, e) in tiff_tags {
            tags0.push((*t, e.clone()));
        }
        tags0.push((0x8769, Entry::Long(exif_start)));
        tags0.sort_by_key(|(t, _)| *t);
        let (ifd0, blob0) = ifd(&tags0, ifd0_data);
        let exif_len = 2 + exif_tags.len() as u32 * 12 + 4;
        let (ifd1, blob1) = ifd(exif_tags, exif_start + exif_len);
        let mut out = vec![b'I', b'I', 42, 0];
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&ifd0);
        out.extend_from_slice(&blob0);
        out.extend_from_slice(&ifd1);
        out.extend_from_slice(&blob1);
        out
    }

    #[derive(Clone)]
    enum Entry {
        Ascii(&'static str),
        Short(u16),
        Long(u32),
        Rational(u32, u32),
    }

    #[test]
    fn reads_the_common_tags() {
        // tags must be ascending in a TIFF IFD
        let raw = tiff(
            &[
                (0x010f, Entry::Ascii("Canon")),
                (0x0110, Entry::Ascii("Canon EOS R6")),
                (0x0112, Entry::Short(6)),
                (0x0131, Entry::Ascii("darktable 4.6")),
                (0x0132, Entry::Ascii("2024:05:01 12:30:45")),
            ],
            &[
                (0x829a, Entry::Rational(1, 250)),
                (0x829d, Entry::Rational(18, 10)),
                (0x8827, Entry::Short(400)),
                (0x9003, Entry::Ascii("2024:05:01 12:30:46")),
                (0x920a, Entry::Rational(50, 1)),
                (0xa405, Entry::Short(80)),
            ],
        );
        let info = from_raw(raw).expect("exif");
        assert_eq!(info.make.as_deref(), Some("Canon"));
        assert_eq!(info.model.as_deref(), Some("Canon EOS R6"));
        assert_eq!(info.orientation, Some(6));
        assert_eq!(info.software.as_deref(), Some("darktable 4.6"));
        assert_eq!(info.date.as_deref(), Some("2024-05-01 12:30:46"));
        assert_eq!(info.exposure.as_deref(), Some("1/250"));
        assert_eq!(info.f_number, Some(1.8));
        assert_eq!(info.iso, Some(400));
        assert_eq!(info.focal_length, Some(50.0));
        assert_eq!(info.focal_length_35mm, Some(80));
        assert_eq!(info.lens, None);
    }

    #[test]
    fn formats_exposures() {
        assert_eq!(format_exposure(1.0 / 250.0).as_deref(), Some("1/250"));
        assert_eq!(format_exposure(0.5).as_deref(), Some("1/2"));
        assert_eq!(format_exposure(2.0).as_deref(), Some("2"));
        assert_eq!(format_exposure(2.5).as_deref(), Some("2.5"));
        assert_eq!(format_exposure(0.0), None);
    }

    #[test]
    fn no_exif_is_none() {
        assert_eq!(from_raw(vec![0, 1, 2, 3]), None);
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("plain.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        assert_eq!(read(&png), None);
        assert_eq!(read(&dir.path().join("missing.jpg")), None);
    }
}
