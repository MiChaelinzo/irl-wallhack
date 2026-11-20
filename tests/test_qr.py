"""QR generator: structure and determinism always; an independent decoder (OpenCV) when installed."""
import pytest

from wallhack import qr

URL = "http://192.168.1.10:8000/pair?token=" + "Ab3_-" * 6


def test_matrix_is_square_deterministic_and_has_finders():
    m = qr.encode(URL)
    assert m == qr.encode(URL)
    assert len(m) == len(m[0]) and all(set(r) <= {"0", "1"} and len(r) == len(m) for r in m)
    assert m[0][:7] == "1111111" and m[6][:7] == "1111111" and m[3][:7] == "1011101"
    assert m[0][-7:] == "1111111" and m[-1][:7] == "1111111"


def test_sizes_follow_versions_and_overlong_text_is_refused():
    assert len(qr.encode("a")) == 21
    assert len(qr.encode("a" * 106)) == 41
    with pytest.raises(ValueError):
        qr.encode("a" * 107)


@pytest.mark.parametrize("text", ["a", URL, "z" * 106])
def test_decodes_with_independent_reader(text):
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    m = qr.encode(text)
    img = np.array([[0 if c == "1" else 255 for c in r] for r in m], dtype=np.uint8)
    img = cv2.resize(np.pad(img, 4, constant_values=255), None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    assert cv2.QRCodeDetector().detectAndDecode(img)[0] == text
