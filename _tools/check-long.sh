#!/bin/bash
cd /home/galt/repo_radicle_clone2/chaosD6
find assets -type f 2>/dev/null | awk '{print length, $0}' | sort -rn | head -10
