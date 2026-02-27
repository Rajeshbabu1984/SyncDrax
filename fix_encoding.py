import os

BASE = os.path.dirname(os.path.abspath(__file__))

FILES = [
    'frontend/index.html', 'frontend/chat.html', 'frontend/meeting.html',
    'frontend/admin.html', 'frontend/tos.html',
    'frontend/js/chatapp.js', 'frontend/js/backgrounds.js',
    'frontend/js/meeting.js', 'frontend/js/webrtc.js', 'frontend/js/config.js',
    'backend/main.py',
]

# Windows-1252 → Unicode mappings for the common "curly" characters
WIN1252 = [
    ('\x97', '\u2014'),  # em dash  —
    ('\x96', '\u2013'),  # en dash  –
    ('\x85', '\u2026'),  # ellipsis …
    ('\xa9', '\u00a9'),  # copyright ©
    ('\xae', '\u00ae'),  # registered ®
    ('\x92', '\u2019'),  # right single quote '
    ('\x93', '\u201c'),  # left double quote "
    ('\x94', '\u201d'),  # right double quote "
    ('\x80', '\u20ac'),  # euro €
]

BAD_FAVICON  = "font-size='90'>?<"
GOOD_FAVICON = "font-size='90'>⚡<"

for rel in FILES:
    path = os.path.join(BASE, rel.replace('/', os.sep))
    if not os.path.exists(path):
        print(f'SKIP (not found): {rel}')
        continue

    raw = open(path, 'rb').read()

    try:
        text = raw.decode('utf-8')
        already_utf8 = True
    except UnicodeDecodeError:
        text = raw.decode('latin-1')
        already_utf8 = False
        for bad, good in WIN1252:
            text = text.replace(bad, good)

    # Fix broken favicon emoji regardless of encoding
    if BAD_FAVICON in text:
        text = text.replace(BAD_FAVICON, GOOD_FAVICON)
        print(f'  Fixed favicon in {rel}')

    if not already_utf8:
        open(path, 'w', encoding='utf-8', newline='').write(text)
        print(f'Re-encoded → UTF-8: {rel}')
    else:
        # Rewrite anyway to normalise line endings
        open(path, 'w', encoding='utf-8', newline='').write(text)
        print(f'OK (was UTF-8): {rel}')

print('\nDone.')
