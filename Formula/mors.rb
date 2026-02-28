class Mors < Formula
  desc "Markdown-first encrypted local CLI messaging"
  homepage "https://github.com/jstxn/mors"
  url "https://registry.npmjs.org/mors/-/mors-0.1.0.tgz"
  sha256 "99910c0e70f4992ae903aff5de45042f794edc972ef5308166d0ba8318d2945e"
  license "UNLICENSED"

  depends_on "python" => :build
  depends_on "node"
  depends_on "sqlcipher"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mors --version")
  end
end
