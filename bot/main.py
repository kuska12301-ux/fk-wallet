"""FK Wallet Telegram companion. Standard library only; no balance or payment logic."""
import html
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

log = logging.getLogger("fk_bot")


class TelegramError(Exception):
    def __init__(self, code, retry_after=0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(f"Telegram API error {code}")


class Telegram:
    def __init__(self, token):
        self.token = token

    def call(self, method, **params):
        request = Request(
            f"https://api.telegram.org/bot{self.token}/{method}",
            data=json.dumps(params).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=35) as response:
                data = json.loads(response.read(1_000_000))
        except HTTPError as error:
            try:
                data = json.loads(error.read(100_000))
            except (ValueError, OSError):
                raise TelegramError(error.code) from None
        except (URLError, TimeoutError, OSError, ValueError):
            # Never log an exception containing the request URL / bot token.
            raise TelegramError("network") from None
        if data.get("ok") is not True:
            raise TelegramError(data.get("error_code", "invalid_response"), data.get("parameters", {}).get("retry_after", 0))
        return data["result"]


def mini_app_url(env):
    value = env.get("MINI_APP_URL") or (env.get("PUBLIC_URL", "").rstrip("/") + "/mini-app")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("MINI_APP_URL должен быть HTTPS-адресом вашего мини-приложения без параметров.")
    return urlunsplit(parsed)


def welcome_request(message, app_url, bot_username):
    """Return a reply only for an incoming command in a private chat."""
    chat = message.get("chat", {})
    if chat.get("type") != "private" or not isinstance(chat.get("id"), int):
        return None
    text = message.get("text", "")
    if not isinstance(text, str):
        return None
    match = re.fullmatch(r"/(start|wallet|help)(?:@([A-Za-z0-9_]+))?(?:\s+(.+))?", text.strip())
    if not match or (match[2] and match[2].lower() != bot_username.lower()):
        return None
    name = html.escape(str(message.get("from", {}).get("first_name", ""))[:80])
    greeting = f"Привет, {name}!" if name else "Добро пожаловать!"
    url = app_url
    if match[3] and re.fullmatch(r"pay_[a-f0-9-]{36}", match[3]):
        url += "#pay=" + match[3][4:]
    return {
        "chat_id": chat["id"],
        "text": f"{greeting}\n\n<b>FK Wallet</b> — ваш кошелёк прямо в Telegram.\n\nПополняйте баланс через CryptoBot, оплачивайте покупки и выводите USDT. Всё — в одном мини-приложении.\n\nНажмите кнопку ниже, чтобы открыть кошелёк.",
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": [[{"text": "Открыть FK Wallet", "web_app": {"url": url}}]]},
    }


class Cursor:
    def __init__(self, filename):
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(filename)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS polling_cursor (id INTEGER PRIMARY KEY CHECK(id=1), next_update INTEGER NOT NULL)")
        self.db.commit()

    def read(self):
        row = self.db.execute("SELECT next_update FROM polling_cursor WHERE id=1").fetchone()
        return row[0] if row else 0

    def save(self, offset):
        self.db.execute("INSERT INTO polling_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_update=excluded.next_update", (offset,))
        self.db.commit()

    def close(self):
        self.db.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("BOT_TOKEN", "")
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
        raise ValueError("Заполните BOT_TOKEN токеном существующего FK Wallet бота.")
    app_url = mini_app_url(os.environ)
    telegram = Telegram(token)
    me = telegram.call("getMe")
    if telegram.call("getWebhookInfo").get("url"):
        raise ValueError("У бота настроен Telegram webhook. Long polling не запущен: проверьте настройку webhook.")
    telegram.call("setMyCommands", commands=[{"command": "start", "description": "Открыть FK Wallet"}])
    telegram.call("setChatMenuButton", menu_button={"type": "web_app", "text": "FK Wallet", "web_app": {"url": app_url}})
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    cursor = Cursor(os.environ.get("BOT_STATE_PATH", "./data/telegram-bot.sqlite"))
    earliest = int(time.time()) - 300
    offset = cursor.read()
    delay = 1
    log.info("FK Wallet Python: @%s, обработчик /start запущен", me["username"])
    try:
        while not stop.is_set():
            try:
                updates = telegram.call("getUpdates", offset=offset, timeout=25, allowed_updates=["message"])
                for update in updates:
                    if stop.is_set():
                        break
                    message = update.get("message", {})
                    # Do not greet people for old commands that predate deployment.
                    reply = welcome_request(message, app_url, me["username"]) if message.get("date", 0) >= earliest else None
                    if reply:
                        try:
                            telegram.call("sendMessage", **reply)
                            log.info("Приветствие /start отправлено")
                        except TelegramError as error:
                            if error.code not in (400, 403):
                                raise
                            log.warning("Приветствие отклонено Telegram, код %s", error.code)
                    offset = update["update_id"] + 1
                    cursor.save(offset)
                delay = 1
            except TelegramError as error:
                if error.code in (401, 409):
                    log.error("Polling остановлен, код %s. Проверьте токен и отсутствие второго polling-процесса.", error.code)
                    return 1
                log.warning("Telegram временно недоступен, код %s. Повтор подключения.", error.code)
                stop.wait(min(max(delay, error.retry_after), 60))
                delay = min(delay * 2, 30)
    finally:
        cursor.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (TelegramError, ValueError) as error:
        print(str(error), flush=True)
        raise SystemExit(1) from None
