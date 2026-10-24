# frozen_string_literal: true

# The minitest recorder. firstlight loads it into every Ruby process a
# check starts, through RUBYOPT, before minitest itself loads, so it waits
# for the Minitest constant and then adds a reporter in Minitest.run, which
# minitest 5 and 6 both call. It records nothing while FIRSTLIGHT_TESTS is
# unset. Ruby 3.2 or later: Module#const_added is the hook.

require_relative "firstlight_tests"

module FirstlightMinitest
  class Reporter
    def start; end

    def prerecord(_klass, _name); end

    def record(result)
      file, line = result.source_location
      status = if result.skipped? then "skipped" elsif result.passed? then "passed" else "failed" end
      FirstlightTests.write(
        file: file,
        line: line,
        name: "#{result.klass}##{result.name}",
        status: status,
        seconds: result.time,
        message: status == "failed" ? FirstlightTests.headline(result.failure) : nil,
        rerun: rerun(result, file, line)
      )
    end

    def report; end

    def passed? = true

    private

    def rerun(result, file, line)
      path = FirstlightTests.quote(relative(file))
      if defined?(::Rails) && File.exist?("bin/rails")
        "bin/rails test #{path}:#{line}"
      else
        FirstlightTests.bundled("ruby -Ilib -Itest #{path} --name #{FirstlightTests.quote("#{result.klass}##{result.name}")}")
      end
    end

    def relative(file)
      absolute = File.expand_path(file)
      prefix = "#{Dir.pwd}/"
      absolute.start_with?(prefix) ? absolute.delete_prefix(prefix) : absolute
    end
  end

  module Hook
    def init_plugins(options)
      super
      reporter << Reporter.new if reporter && FirstlightTests.out
    end
  end
end

class Object
  class << self
    prepend(Module.new do
      def const_added(name)
        super
        ::Minitest.singleton_class.prepend(FirstlightMinitest::Hook) if self == ::Object && name == :Minitest
      end
    end)
  end
end
