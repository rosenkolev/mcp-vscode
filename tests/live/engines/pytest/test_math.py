import pytest

from math_utils import add, subtract


def test_adds():
    assert add(1, 2) == 3


def test_subtracts():
    assert subtract(3, 1) == 1


@pytest.mark.skip(reason="fixture")
def test_skipped():
    pass
