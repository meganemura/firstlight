# frozen_string_literal: true

# What the Ruby recorders share: appending one line per finished test to
# the file FIRSTLIGHT_TESTS names, in the shape firstlight's src/tests.ts
# reads, and the parts of a rerun command that depend on how the process
# started. It loads only the standard library.

require "json"

module FirstlightTests
  module_function

  def out
    path = ENV["FIRSTLIGHT_TESTS"]
    path.nil? || path.empty? ? nil : path
  end

  # One File#write per line, on a file opened for append, is one write(2)
  # with O_APPEND, so lines from parallel workers never interleave.
  def write(file:, line:, name:, status:, seconds:, message:, rerun:)
    record = {
      file: File.expand_path(file),
      line: line,
      name: name,
      status: status,
      duration_ms: seconds.nil? ? nil : (seconds * 1000).round(1),
      message: message,
      rerun: rerun,
      cwd: Dir.pwd
    }
    File.open(out, "a") { |io| io.write("#{JSON.generate(record)}\n") }
  end

  # The first lines of an exception's message, because RSpec's and
  # minitest's "expected: 3" alone hides the "got: 2" on the next line.
  def headline(exception)
    return nil if exception.nil?

    lines = exception.message.to_s.lines.map(&:strip).reject(&:empty?)
    lines.empty? ? exception.class.name : lines.first(HEADLINE_LINES).join(" ")
  end

  HEADLINE_LINES = 3

  # Bundler sets BUNDLE_GEMFILE for the processes `bundle exec` starts, so
  # the rerun goes through it too.
  def bundled(command)
    ENV["BUNDLE_GEMFILE"].to_s.empty? ? command : "bundle exec #{command}"
  end

  def quote(word)
    return word if word.match?(%r{\A[A-Za-z0-9_./:@%+=,-]+\z})

    "'#{word.gsub("'", "'\\\\''")}'"
  end
end
