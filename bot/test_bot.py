import os
import tempfile
import unittest
from main import Cursor, mini_app_url, welcome_request


class WelcomeTests(unittest.TestCase):
    def test_private_start_opens_same_mini_app_and_escapes_name(self):
        reply = welcome_request({"chat":{"id":123,"type":"private"},"from":{"first_name":"<Admin>"},"text":"/start"}, "https://wallet.example/mini-app", "FK_WALLEET_BOT")
        self.assertIn("&lt;Admin&gt;", reply["text"])
        self.assertEqual(reply["chat_id"],123)
        self.assertEqual(reply["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"],"https://wallet.example/mini-app")

    def test_no_response_to_groups_arbitrary_text_or_another_bot(self):
        for text,kind in [("/start","group"),("hello","private"),("/start@other_bot","private")]:
            self.assertIsNone(welcome_request({"chat":{"id":123,"type":kind},"text":text},"https://wallet.example/mini-app","FK_WALLEET_BOT"))

    def test_invoice_start_parameter_preserves_checkout(self):
        invoice="12345678-1234-1234-1234-123456789012"
        reply=welcome_request({"chat":{"id":123,"type":"private"},"text":"/start pay_"+invoice},"https://wallet.example/mini-app","FK_WALLEET_BOT")
        self.assertTrue(reply["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"].endswith("#pay="+invoice))

    def test_https_configuration_and_persistent_cursor(self):
        self.assertEqual(mini_app_url({"PUBLIC_URL":"https://wallet.example"}),"https://wallet.example/mini-app")
        with self.assertRaises(ValueError):
            mini_app_url({"MINI_APP_URL":"http://wallet.example"})
        with tempfile.TemporaryDirectory() as directory:
            filename=os.path.join(directory,"state.sqlite")
            cursor=Cursor(filename);self.assertEqual(cursor.read(),0);cursor.save(1234);cursor.close()
            cursor=Cursor(filename);self.assertEqual(cursor.read(),1234);cursor.close()


if __name__ == "__main__":
    unittest.main()
