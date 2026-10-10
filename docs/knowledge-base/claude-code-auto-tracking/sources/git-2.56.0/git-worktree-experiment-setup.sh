set -e
R=/private/tmp/claude-501/-Users-user-projects-claude-code-mod-tracking/29484de1-cef4-4282-97e8-750e88984c88/scratchpad/exp/repo
rm -rf $R $R-*; mkdir -p $R; cd $R
export GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@example.com
git init -q -b main .
c(){ echo "$1" >> f.txt; git add f.txt; git commit -q -m "$1"; }
c m1; c m2
git checkout -q -b feat/parent          # master session branch
c p1; c p2
mkdir -p .claude/worktrees
echo "### W1: Claude-style worktree-agent branch from explicit start-point feat/parent (zero commits)"
git worktree add -q -b worktree-agent-aaa .claude/worktrees/agent-aaa feat/parent
echo "### W2: worktree add -b with NO start-point (defaults HEAD)"
git worktree add -q -b wf-bbb .claude/worktrees/wf_bbb-1
echo "### W3: unrelated worktree off main tip (older ancestor of parent)"
git worktree add -q -b feat/unrelated ../repo-unrelated main
echo "### W4: child-of-child: created from INSIDE W1, start HEAD, then with a commit"
(cd .claude/worktrees/agent-aaa; c a1; git worktree add -q -b worktree-child-ccc ../child-ccc; cd ../child-ccc; c c1; git worktree add -q -b grandchild-ddd ../grand-ddd; cd ../grand-ddd; c d1)
echo "### W5: detached worktree at parent tip"
git worktree add -q --detach .claude/worktrees/detached-eee feat/parent
echo "### W6: parent advances after fork (p3), W2 gets a commit"
c p3
(cd .claude/worktrees/wf_bbb-1; c b1)
echo "### W7: locked + prunable worktree"
git worktree add -q -b locked-fff ../repo-locked feat/parent; git worktree lock --reason "claude agent running" ../repo-locked
git worktree add -q -b gone-ggg ../repo-gone feat/parent; rm -rf ../repo-gone
echo "### W8: branch created separately, then worktree add of existing branch"
git branch preexisting-hhh feat/parent
git worktree add -q ../repo-pre preexisting-hhh
echo "### W9: sibling off main created with commits but never merged"
git worktree add -q -b feat/sibling-of-main ../repo-sib main; (cd ../repo-sib; c s1)
