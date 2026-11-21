# Writes the subtitle encoding fixtures for ewe-app-core's text tests with Python's own
# codecs (independent of encoding_rs). Usage: python3 -I make_text_fixtures.py <outdir>
import os, sys
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
LINES = {
    "ru": ["Привет! Как дела?", "Сегодня очень холодно, правда?", "Я не знаю, где он сейчас.", "Пойдём домой, уже поздно.", "Спасибо тебе за всё, друг мой."],
    "ar": ["مرحبا! كيف حالك؟", "الجو بارد جدا اليوم، أليس كذلك؟", "لا أعرف أين هو الآن.", "هيا نذهب إلى البيت، لقد تأخر الوقت.", "شكرا لك على كل شيء يا صديقي."],
    "el": ["Γεια σου! Τι κάνεις;", "Κάνει πολύ κρύο σήμερα, έτσι δεν είναι;", "Δεν ξέρω πού είναι τώρα.", "Πάμε σπίτι, είναι ήδη αργά.", "Ευχαριστώ για όλα, φίλε μου."],
    "he": ["שלום! מה שלומך?", "קר מאוד היום, נכון?", "אני לא יודע איפה הוא עכשיו.", "בוא נלך הביתה, כבר מאוחר.", "תודה לך על הכול, חבר שלי."],
    "tr": ["Merhaba! Nasılsın?", "Bugün hava çok soğuk, değil mi?", "Şu anda nerede olduğunu bilmiyorum.", "Hadi eve gidelim, artık geç oldu.", "Her şey için teşekkür ederim, dostum."],
    "zh": ["你好！你最近怎么样？", "今天天气非常冷，对吧？", "我不知道他现在在哪里。", "我们回家吧，已经很晚了。", "谢谢你为我做的一切，朋友。"],
    "zh-TW": ["你好！你最近怎麼樣？", "今天天氣非常冷，對吧？", "我不知道他現在在哪裡。", "我們回家吧，已經很晚了。", "謝謝你為我做的一切，朋友。"],
    "ja": ["こんにちは！元気ですか？", "今日はとても寒いですね。", "彼が今どこにいるのか分かりません。", "もう遅いから、家に帰ろう。", "いろいろありがとう、友よ。"],
    "ko": ["안녕하세요! 잘 지내세요?", "오늘은 정말 춥네요, 그렇죠?", "그가 지금 어디에 있는지 모르겠어요.", "이제 늦었으니 집에 가자.", "모든 것에 감사해요, 친구."],
    "fr": ["Bonjour ! Ça va, mon vieux ?", "Il fait très froid aujourd'hui, n'est-ce pas ?", "Je ne sais pas où il est en ce moment.", "Rentrons à la maison, il est déjà tard.", "Merci pour tout, mon frère. À bientôt !"],
    "ka": ["გამარჯობა! როგორ ხარ?", "დღეს ძალიან ცივა, არა?", "არ ვიცი, სად არის ახლა.", "წავიდეთ სახლში, უკვე გვიანია.", "გმადლობ ყველაფრისთვის, მეგობარო. 🐑"],
}
def srt(lines):
    out = []
    for i, line in enumerate(lines):
        s, e = 1 + i * 4, 4 + i * 4
        out.append(f"{i+1}\r\n00:00:{s:02d},000 --> 00:00:{e:02d},500\r\n{line}\r\n")
    return "\r\n".join(out)
def write(name, data):
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)
for lang, lines in LINES.items():
    write(f"{lang}.utf8.srt", srt(lines).encode("utf-8"))
ENC = [("ru", "cp1251", "cp1251"), ("ar", "cp1256", "cp1256"), ("el", "cp1253", "cp1253"),
       ("he", "cp1255", "cp1255"), ("tr", "cp1254", "cp1254"), ("zh", "gbk", "gbk"),
       ("zh", "gb18030", "gb18030"), ("zh-TW", "big5", "big5"), ("ja", "shift_jis", "shift_jis"),
       ("ko", "euc-kr", "euc_kr"), ("fr", "latin1", "latin-1")]
for lang, tag, codec in ENC:
    write(f"{lang}.{tag}.srt", srt(LINES[lang]).encode(codec))
write("ru.utf16le-bom.srt", b"\xff\xfe" + srt(LINES["ru"]).encode("utf-16-le"))
write("ja.utf16be-bom.srt", b"\xfe\xff" + srt(LINES["ja"]).encode("utf-16-be"))
write("ar.utf8-bom.srt", b"\xef\xbb\xbf" + srt(LINES["ar"]).encode("utf-8"))
write("fr.utf16le.srt", srt(LINES["fr"]).encode("utf-16-le"))
print("ok", len(os.listdir(out)))
