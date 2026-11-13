"""OS-held workspace ownership; recovery only runs after the previous Core exited."""
import os
from pathlib import Path

from bittune_core.contracts import ContractError
from bittune_core.store import core_home


class CoreLease:
    def __init__(self, home=None):
        root = Path(home) if home else core_home()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.file = (root / "core.lock").open("a+b")
        os.chmod(root / "core.lock", 0o600)
        try:
            if os.name == "nt":
                import msvcrt
                if self.file.seek(0, 2) == 0:
                    self.file.write(b"0")
                    self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.file.close()
            raise ContractError("core_busy", "该工作区已有活跃Core；请等待当前CLI或Web任务结束。") from error

    def close(self):
        self.file.close()
